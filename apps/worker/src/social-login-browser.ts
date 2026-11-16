import { chromium, type Browser, type Page } from 'playwright';
import { generateTotp, type SocialCredentials } from '@sonar/core/social-login';
import {
  generateSocialDevice,
  type ResolvedSocialSession,
} from '@sonar/core/social-session';
import type { SocialNetwork } from '@sonar/core';
import { assertSocialSession } from './social-send-browser.js';

export type SocialLoginResult = {
  valid: boolean;
  reason?:
    | 'wrong_password'
    | 'captcha'
    | 'checkpoint'
    | 'code_expired'
    | 'login_failed';
  screenshot?: string;
};
export type SocialLoginSession = Pick<
  ResolvedSocialSession,
  'proxy' | 'device' | 'storageState' | 'persistDevice' | 'persistStorageState'
>;
export type SocialLoginChallenge = {
  waitForCode(kind: 'email' | 'sms'): Promise<string | null>;
};
const loginUrls = {
  instagram: 'https://www.instagram.com/accounts/login/',
  facebook: 'https://www.facebook.com/login/',
  linkedin: 'https://www.linkedin.com/login',
};
const loginInputs = {
  // Instagram's 2026 login form names the field "email" (it accepts a username too).
  instagram: 'input[name="username"],input[name="email"]',
  facebook: 'input[name="email"],input[name="email_address"]',
  linkedin: 'input[name="session_key"],input#username',
};
const codeSelector =
  'input[name="verificationCode"],input[name="security_code"],input[name="approvals_code"],input[name="pin"],input#input__phone_verification_pin,input[autocomplete="one-time-code"],input[inputmode="numeric"],input[type="tel"],input[type="number"],input[maxlength="6"],input[maxlength="8"]';
const twoStepPath =
  /two_step_verification|two_factor|\/checkpoint\/.*(?:code|two)/i;
/** Instagram's 2026 two-step page uses a plain, unnamed text input for the code. */
function codeInputs(page: Page) {
  return twoStepPath.test(page.url())
    ? `${codeSelector},input[type="text"],input:not([type])`
    : codeSelector;
}
const captchaSelector =
  'iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="captcha"],input[name="captcha_response"],#captcha';
const identitySelector =
  'input[type="file"],a[href*="identity/confirm"],a[href*="id-upload"]';
async function visible(page: Page, selector: string) {
  return (await page.locator(selector).filter({ visible: true }).count()) > 0;
}
/** Only fixed outcomes leave the browser; DOM text, credentials and errors never do. */
async function loginState(
  page: Page,
  network: SocialNetwork,
  timeoutMs: number,
) {
  if (await visible(page, captchaSelector)) return 'captcha' as const;
  const body = (await page.locator('body').innerText()).slice(0, 12000);
  if (
    (await visible(page, identitySelector)) ||
    /confirm your identity|confirm (?:it[’']?s|this is) you|підтверд.{0,20}що це ви|подтверд.{0,20}это вы|upload.{0,25}(?:id|photo)|підтверд.{0,20}особ|подтверд.{0,20}личност/i.test(
      body,
    )
  )
    return 'checkpoint' as const;
  if (
    /incorrect password|wrong password|password.{0,20}(?:incorrect|wrong)|неправильн.{0,12}парол|(?:невірн|неверн).{0,12}парол|пароль.{0,20}(?:неправильн|невірн)|sorry, your password was incorrect/i.test(
      body,
    )
  )
    return 'wrong_password' as const;
  if (await visible(page, codeInputs(page))) {
    if (
      /authentication app|authenticator|code generator|(?:додатк|програм).{0,25}(?:автентиф|аутентиф)|приложени.{0,20}аутентиф|генератор.{0,10}код/i.test(
        body,
      )
    )
      return 'totp' as const;
    if (
      /\bsms\b|text message|текстов.{0,10}повідом|текстов.{0,10}сообщ/i.test(
        body,
      )
    )
      return 'sms' as const;
    // On the two-step page footer/help text mentions email; only a "code sent to email" means email.
    const twoStep = twoStepPath.test(page.url());
    if (
      twoStep
        ? /(?:sent|надісл|відправ|отправ).{0,40}(?:e-?mail|пошт|почт)/i.test(
            body,
          )
        : /e-?mail|ел\.\s?(?:пошт|адрес)|електронн|электронн|почт/i.test(body)
    )
      return 'email' as const;
    // Instagram's 2026 two-step page with only an authenticator app set up.
    return twoStepPath.test(page.url())
      ? ('totp' as const)
      : ('email' as const);
  }
  if (/captcha|verify you are human|підтверд.{0,20}людина/i.test(body))
    return 'captcha' as const;
  if (
    /\/checkpoint\/(?!.*(?:challenge|verify))/i.test(page.url()) ||
    /\/challenge\//i.test(page.url())
  )
    return 'checkpoint' as const;
  try {
    await assertSocialSession(page, network, Math.min(timeoutMs, 250));
    return 'authenticated' as const;
  } catch {
    return 'pending' as const;
  }
}
async function settledState(
  page: Page,
  network: SocialNetwork,
  timeoutMs: number,
  /** After a code is submitted the same page stays up while it is checked: keep waiting. */
  submitted?: { state: string; url: string },
) {
  const deadline = Date.now() + timeoutMs;
  do {
    const state = await loginState(page, network, timeoutMs);
    const unchanged =
      submitted?.state === state && submitted.url === page.url();
    if (state !== 'pending' && !unchanged) return state;
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  return 'pending' as const;
}
type LoginDiagnostics = {
  stage: string;
  state?: string;
  page?: Page;
  path?: string;
  error?: unknown;
  snapshot?: PageSnapshot;
  screenshot?: string;
  response?: { status: number; type: string; length: string };
  blocked?: Set<string>;
};
type PageSnapshot = {
  title: string;
  inputs: string[];
  buttons: string[];
  textLength: number;
};
/** Structure only: title, input name/type/visibility and short button labels; never page text or values. */
/** Viewport JPEG for the owner; password inputs render masked. */
async function pageScreenshot(page?: Page): Promise<string | undefined> {
  if (typeof page?.screenshot !== 'function') return undefined;
  try {
    const image = await page.screenshot({
      type: 'jpeg',
      quality: 55,
      timeout: 5000,
    });
    return image.toString('base64');
  } catch {
    return undefined;
  }
}
async function pageSnapshot(page?: Page): Promise<PageSnapshot | undefined> {
  if (typeof page?.evaluate !== 'function') return undefined;
  return page
    .evaluate(() => ({
      title: document.title.slice(0, 80),
      inputs: Array.from(document.querySelectorAll('input'))
        .slice(0, 12)
        .map(
          (input) =>
            `${input.name || '-'}:${input.type}:${(input as HTMLElement).offsetParent ? 'v' : 'h'}`,
        ),
      buttons: Array.from(document.querySelectorAll('button,[role="button"]'))
        .map((button) => (button as HTMLElement).innerText.trim().slice(0, 40))
        .filter(Boolean)
        .slice(0, 8),
      textLength: document.body?.innerText.length ?? 0,
    }))
    .catch(() => undefined);
}
function pagePath(page?: Page) {
  try {
    return page ? new URL(page.url()).pathname.slice(0, 120) : undefined;
  } catch {
    return undefined;
  }
}
/** Fixed fields only: stage, detected state, URL path and the error class/first line, with credentials scrubbed. */
export function loginDiagnostics(
  channel: SocialNetwork,
  result: SocialLoginResult,
  diag: LoginDiagnostics,
  credentials: SocialCredentials,
) {
  const scrub = (text: string) =>
    [credentials.login, credentials.password, credentials.totpSecret]
      .filter((value): value is string => !!value && value.length > 2)
      .reduce((out, value) => out.split(value).join('***'), text);
  let error: string | undefined;
  if (diag.error) {
    const raw =
      diag.error instanceof Error
        ? `${diag.error.name}: ${diag.error.message}`
        : 'error';
    error = [credentials.login, credentials.password, credentials.totpSecret]
      .filter((value): value is string => !!value && value.length > 2)
      .reduce(
        (text, value) => text.split(value).join('***'),
        raw.split(/\r?\n/)[0]!,
      )
      .slice(0, 200);
  }
  return {
    channel,
    reason: result.reason,
    stage: diag.stage,
    state: diag.state,
    path: diag.path,
    ...(error ? { error } : {}),
    ...(diag.snapshot ? { page: scrub(JSON.stringify(diag.snapshot)) } : {}),
    ...(diag.response ? { response: diag.response } : {}),
    ...(diag.blocked?.size ? { blocked: [...diag.blocked].slice(0, 10) } : {}),
  };
}
export function createSocialLoginBrowser(
  launch = () =>
    chromium.launch({
      headless: true,
      proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
      args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    }),
) {
  let browser: Promise<Browser> | undefined;
  const active = new Set<import('playwright').BrowserContext>();
  async function attempt(
    account: { channel: SocialNetwork },
    session: SocialLoginSession,
    credentials: SocialCredentials,
    challenge: SocialLoginChallenge,
    timeoutMs: number,
    diag: LoginDiagnostics,
  ): Promise<SocialLoginResult> {
    let context: import('playwright').BrowserContext | undefined;
    try {
      browser ??= launch().catch(() => {
        browser = undefined;
        throw new Error('browser');
      });
      const running = await browser;
      const device = session.device?.userAgent
        ? session.device
        : generateSocialDevice(account.channel, running.version());
      if (!session.device?.userAgent) await session.persistDevice?.(device);
      context = await running.newContext({
        ...device,
        proxy: session.proxy,
        serviceWorkers: 'block',
        acceptDownloads: false,
      });
      active.add(context);
      const domains = [
        `${account.channel}.com`,
        ...{
          // The 2026 Instagram login flow loads parts of Meta's shared login from facebook.com.
          instagram: ['cdninstagram.com', 'fbcdn.net', 'facebook.com'],
          facebook: ['fbcdn.net', 'fbsbx.com'],
          linkedin: ['licdn.com'],
        }[account.channel],
      ];
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        const allowed =
          url.protocol === 'https:' &&
          !url.port &&
          !url.username &&
          !url.password &&
          domains.some(
            (host) =>
              url.hostname === host || url.hostname.endsWith(`.${host}`),
          );
        if (!allowed) (diag.blocked ??= new Set()).add(url.hostname);
        return allowed ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      diag.page = page;
      diag.stage = 'open';
      page.setDefaultTimeout(timeoutMs);
      await page.routeWebSocket('**/*', (socket) => socket.close());
      const response = await page.goto(loginUrls[account.channel], {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });
      if (response) {
        const headers = response.headers();
        diag.response = {
          status: response.status(),
          type: (headers['content-type'] ?? '').slice(0, 40),
          length: (headers['content-length'] ?? '').slice(0, 12),
        };
      }
      const consent = page
        .getByRole('button', {
          name: /^(?:Decline optional cookies|Only allow essential cookies|Відхилити необов’язкові файли cookie|Отклонить необязательные файлы cookie)$/i,
        })
        .filter({ visible: true });
      if (await consent.count()) await consent.first().click();
      diag.stage = 'login_form';
      const initial = await loginState(page, account.channel, timeoutMs);
      diag.state = initial;
      if (initial === 'captcha' || initial === 'checkpoint')
        return { valid: false, reason: initial };
      await page
        .locator(loginInputs[account.channel])
        .filter({ visible: true })
        .first()
        .fill(credentials.login);
      const password = page
        .locator('input[type="password"]')
        .filter({ visible: true })
        .first();
      await password.fill(credentials.password);
      await password.press('Enter');
      diag.stage = 'after_password';
      let state = await settledState(page, account.channel, timeoutMs);
      diag.state = state;
      let totpSubmitted = false,
        manualSubmitted = false;
      while (state === 'totp' || state === 'email' || state === 'sms') {
        if (
          (state === 'totp' && totpSubmitted) ||
          (state !== 'totp' && manualSubmitted)
        )
          return { valid: false, reason: 'login_failed' };
        if (state === 'totp' && !credentials.totpSecret)
          return { valid: false, reason: 'checkpoint' };
        const code =
          state === 'totp'
            ? generateTotp(credentials.totpSecret!)
            : await challenge.waitForCode(state);
        if (!code) return { valid: false, reason: 'code_expired' };
        if (state === 'totp') totpSubmitted = true;
        else manualSubmitted = true;
        // The same page/context remains live throughout waitForCode (bounded by DB).
        const input = page
          .locator(codeInputs(page))
          .filter({ visible: true })
          .first();
        const submittedUrl = page.url();
        await input.fill(code);
        await input.press('Enter');
        diag.stage = `after_${state}_code`;
        state = await settledState(page, account.channel, timeoutMs, {
          state,
          url: submittedUrl,
        });
        diag.state = state;
      }
      if (state !== 'authenticated')
        return {
          valid: false,
          reason:
            state === 'captcha' ||
            state === 'checkpoint' ||
            state === 'wrong_password'
              ? state
              : 'login_failed',
        };
      await session.persistStorageState?.(await context.storageState(), device);
      diag.stage = 'done';
      return { valid: true };
    } catch (error) {
      diag.error = error;
      return { valid: false, reason: 'login_failed' };
    } finally {
      if (context) {
        if (diag.stage !== 'done') {
          diag.snapshot = await pageSnapshot(diag.page);
          diag.screenshot = await pageScreenshot(diag.page);
        }
        diag.path = pagePath(diag.page);
        active.delete(context);
        await context.close().catch(() => {});
      }
    }
  }
  return {
    async login(
      account: { channel: SocialNetwork },
      session: SocialLoginSession,
      credentials: SocialCredentials,
      challenge: SocialLoginChallenge,
      timeoutMs: number,
    ): Promise<SocialLoginResult> {
      const diag: LoginDiagnostics = { stage: 'launch' };
      const result = await attempt(
        account,
        session,
        credentials,
        challenge,
        timeoutMs,
        diag,
      );
      if (!result.valid && diag.screenshot) result.screenshot = diag.screenshot;
      if (!result.valid)
        console.warn(
          '[social-login] failed',
          JSON.stringify(
            loginDiagnostics(account.channel, result, diag, credentials),
          ),
        );
      return result;
    },
    async close() {
      await Promise.all(
        [...active].map((context) => context.close().catch(() => {})),
      );
      active.clear();
      const running = browser;
      browser = undefined;
      if (running) await (await running).close();
    },
  };
}
export const socialLoginBrowser = createSocialLoginBrowser();
