/// <reference lib="dom" />
import { chromium, type Browser, type Page } from 'playwright';
import {
  SiteHttp,
  SiteUnavailable,
  requestSite,
  type SiteSettings,
} from './site-http.js';
export type FormRequest = {
  url: string;
  website: string;
  name: string;
  email: string;
  phone: string;
  body: string;
  subject?: string;
  captcha?: string;
};
export type FormResult = {
  status: 'sent' | 'awaiting_manual' | 'failed' | 'skipped';
  reasonUk?: string;
  reasonCode?: string;
  evidence?: string;
};
export type FormOptions = {
  settings: SiteSettings;
  beforeSubmit: () => Promise<void>;
  saveScreenshot: (phase: 'before' | 'after', buffer: Buffer) => Promise<void>;
  solveCaptcha?: (captcha: {
    kind: 'recaptcha' | 'hcaptcha' | 'turnstile';
    siteKey: string;
    url: string;
  }) => Promise<string>;
  request?: typeof requestSite;
  launch?: () => Promise<Browser>;
};
const failure = (
  reasonCode: string,
  reasonUk: string,
  status: FormResult['status'] = 'failed',
): FormResult => ({ status, reasonCode, reasonUk });
const successText =
  /thank\s*you|successfully\s*(?:sent|submitted)|message\s*(?:has been\s*)?(?:sent|received)|дяку[єе]мо|повідомлення\s*(?:успішно\s*)?(?:надіслано|відправлено)|спасибо|сообщение\s*(?:отправлено|принято)/i;
const errorText =
  /(?:validation|captcha)\s*(?:error|failed|invalid)|please\s*(?:enter|provide|correct|fill)|invalid\s*(?:email|phone|field)|(?:поле|поля)\s*(?:обов|обяз)|(?:невірн|некоректн|неправильн).*(?:email|адрес|пошт)|не вдалося надіслати/i;

export async function sendWebsiteForm(
  input: FormRequest,
  options: FormOptions,
): Promise<FormResult> {
  const http = new SiteHttp(input.website, options.settings, options.request);
  let browser: Browser | undefined, page: Page | undefined;
  let armed = false,
    filling = false,
    submitted = false,
    routeFailure: unknown,
    evidence = '';
  let bytes = 0,
    count = 0;
  // A request is the submission only if it carries our exact message text, under any field name.
  function containsMessage(url: string, data: string) {
    const matches = (pairs: Iterable<[string, string]>) =>
      Array.from(pairs).some(([, value]) => value === input.body);
    if (
      matches(new URL(url).searchParams) ||
      matches(new URLSearchParams(data))
    )
      return true;
    try {
      const visit = (value: unknown): boolean =>
        !!value &&
        typeof value === 'object' &&
        Object.entries(value).some(
          ([, child]) => child === input.body || visit(child),
        );
      if (visit(JSON.parse(data))) return true;
    } catch {
      /* Form payloads are not JSON. */
    }
    return (
      data === input.body ||
      Array.from(
        data.matchAll(
          /name="([^"]+)"[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n([\s\S]*?)\r\n--/g,
        ),
      ).some((match) => match[2] === input.body)
    );
  }
  let submitResponse:
    { status: number; body: string; xhr: boolean } | undefined;
  let pending: Promise<void> = Promise.resolve();
  let hookError: unknown;
  let responseReady!: () => void;
  const responseDone = new Promise<void>((resolve) => {
    responseReady = resolve;
  });
  const screenshots = new Set<string>();
  async function screenshot(phase: 'before' | 'after') {
    if (page && !screenshots.has(phase)) {
      const buffer = await page.screenshot({
        fullPage: true,
        timeout: options.settings.timeoutMs,
      });
      try {
        await options.saveScreenshot(phase, buffer);
      } catch (error) {
        hookError = error;
        throw error;
      }
      screenshots.add(phase);
    }
  }
  try {
    if (!input.body.trim())
      return failure('validation_error', 'Повідомлення не може бути порожнім.');
    await http.assertAllowed(input.url);
    browser = await (options.launch?.() ??
      chromium.launch({
        headless: true,
        proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
        args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      }));
    const context = await browser.newContext({
      userAgent: options.settings.userAgent,
      serviceWorkers: 'block',
    });
    await context.route('**/*', async (route) => {
      try {
        const req = route.request(),
          method = req.method();
        if (
          ++count > 80 ||
          ['image', 'media', 'font'].includes(req.resourceType())
        )
          return await route.abort();
        const carriesMessage = containsMessage(req.url(), req.postData() ?? '');
        const submission =
          armed &&
          carriesMessage &&
          (method === 'POST' ||
            req.isNavigationRequest() ||
            ['xhr', 'fetch'].includes(req.resourceType()));
        if (
          (!armed &&
            filling &&
            (carriesMessage ||
              ['xhr', 'fetch', 'document'].includes(req.resourceType()))) ||
          (method !== 'GET' && !submission) ||
          (submission && submitted)
        )
          return await route.abort();
        if (submission) {
          submitted = true;
          evidence = req.url();
        }
        const response = await http.exchange(req.url(), {
          method,
          headers: Object.fromEntries(
            Object.entries(await req.allHeaders()).filter(
              ([name]) =>
                ![
                  'host',
                  'connection',
                  'content-length',
                  'accept-encoding',
                ].includes(name),
            ),
          ),
          body: req.postDataBuffer() ?? undefined,
        });
        bytes += response.body.length;
        if (bytes > options.settings.maxBytes)
          throw new SiteUnavailable(
            'size_limit',
            'Сайт перевищує ліміт розміру.',
          );
        const headers = Object.fromEntries(
          Object.entries(response.headers ?? {})
            .filter(
              ([name]) =>
                ![
                  'content-length',
                  'content-encoding',
                  'transfer-encoding',
                  'connection',
                ].includes(name),
            )
            .map(([name, value]) => [
              name,
              Array.isArray(value) ? value.join('\n') : value,
            ]),
        );
        if (response.location) headers.location = response.location;
        if (submission) {
          submitResponse = {
            status: response.status,
            body: Buffer.from(response.body).toString('utf8'),
            xhr: ['xhr', 'fetch'].includes(req.resourceType()),
          };
        }
        await route.fulfill({
          status: response.status,
          contentType: response.contentType || 'text/plain',
          headers,
          body: Buffer.from(response.body),
        });
        if (submission) responseReady();
      } catch (error) {
        if (
          armed ||
          (error instanceof SiteUnavailable && error.code !== 'unsafe_url')
        )
          routeFailure = error;
        if (armed) responseReady();
        await route.abort().catch(() => {});
      }
    });
    page = await context.newPage();
    await page.routeWebSocket('**/*', (socket) => socket.close());
    page.setDefaultTimeout(options.settings.timeoutMs);
    await page.goto(input.url, {
      waitUntil: 'networkidle',
      timeout: options.settings.timeoutMs,
    });
    if (routeFailure) throw routeFailure;
    const found = await page.evaluate(() => {
      const visible = (el: Element) =>
        !!(el as HTMLElement).offsetWidth || !!(el as HTMLElement).offsetHeight;
      const forms = Array.from(document.forms);
      for (const [index, form] of forms.entries()) {
        const fields: Record<string, number> = {};
        const controls = Array.from(form.querySelectorAll('input,textarea'));
        for (const [i, node] of controls.entries()) {
          const el = node as HTMLInputElement;
          if (
            !visible(el) ||
            el.disabled ||
            [
              'hidden',
              'submit',
              'button',
              'file',
              'checkbox',
              'radio',
              'password',
            ].includes(el.type)
          )
            continue;
          const label = `${el.name} ${el.id} ${el.placeholder} ${el.autocomplete} ${el.getAttribute('aria-label') ?? ''} ${Array.from(
            el.labels ?? [],
          )
            .map((l) => l.textContent)
            .join(' ')}`;
          const kind =
            el.tagName === 'TEXTAREA' ||
            /message|comment|повідом|сообщ|текст|запит/i.test(label)
              ? 'body'
              : el.type === 'email' || /email|e-mail|пошт|почт/i.test(label)
                ? 'email'
                : el.type === 'tel' || /phone|тел|mobile/i.test(label)
                  ? 'phone'
                  : /subject|title|тема|звернення/i.test(label)
                    ? 'subject'
                    : /name|ім.я|имя/i.test(label)
                      ? 'name'
                      : undefined;
          if (kind && fields[kind] === undefined) fields[kind] = i;
        }
        if (
          fields.body !== undefined &&
          (fields.email !== undefined || fields.phone !== undefined)
        )
          return {
            index,
            fields,
            action: form.action,
            method: form.method,
            file: !!form.querySelector('input[type=file]'),
          };
      }
      return null;
    });
    if (!found)
      return failure(
        'form_not_found',
        'Контактну форму не знайдено.',
        'skipped',
      );
    if (found.file)
      return failure(
        'file_upload',
        'Форма містить завантаження файлів.',
        'skipped',
      );
    if (!['get', 'post'].includes(found.method.toLowerCase()))
      return failure(
        'unsafe_method',
        'Непідтримуваний метод форми.',
        'skipped',
      );
    await http.assertAllowed(found.action);
    const form = page.locator('form').nth(found.index);
    filling = true;
    for (const [kind, index] of Object.entries(found.fields)) {
      const value =
        kind === 'subject'
          ? (input.subject ?? input.body)
          : input[kind as 'name' | 'email' | 'phone' | 'body'];
      await form.locator('input,textarea').nth(index).fill(value);
    }
    const captcha = await page.evaluate(() => {
      const el = document.querySelector('[data-sitekey]');
      const scripts = Array.from(document.scripts)
        .map((s) => s.src)
        .join(' ');
      const marker = `${el?.className ?? ''} ${scripts} ${document.querySelector('[name="g-recaptcha-response"],[name="h-captcha-response"],[name="cf-turnstile-response"]')?.getAttribute('name') ?? ''}`;
      const kind = /turnstile/i.test(marker)
        ? 'turnstile'
        : /h-captcha|hcaptcha/i.test(marker)
          ? 'hcaptcha'
          : /recaptcha/i.test(marker)
            ? 'recaptcha'
            : null;
      const key =
        el?.getAttribute('data-sitekey') ??
        scripts.match(/[?&]render=([^&\s]+)/)?.[1] ??
        '';
      return { kind, siteKey: key === 'explicit' ? '' : key };
    });
    const hinted = !!input.captcha && input.captcha !== 'none';
    if (captcha.kind || hinted) {
      if (!options.solveCaptcha || !captcha.kind || !captcha.siteKey)
        return failure('captcha_required', 'Потрібна капча', 'awaiting_manual');
      let token: string;
      try {
        token = await options.solveCaptcha({
          kind: captcha.kind as 'recaptcha' | 'hcaptcha' | 'turnstile',
          siteKey: captcha.siteKey,
          url: page.url(),
        });
      } catch {
        return failure('captcha_required', 'Потрібна капча', 'awaiting_manual');
      }
      if (!token)
        return failure('captcha_required', 'Потрібна капча', 'awaiting_manual');
      await form.evaluate(
        (node, value) => {
          const name =
            value.kind === 'turnstile'
              ? 'cf-turnstile-response'
              : value.kind === 'hcaptcha'
                ? 'h-captcha-response'
                : 'g-recaptcha-response';
          let control = node.querySelector(
            `[name="${name}"]`,
          ) as HTMLTextAreaElement | null;
          if (!control) {
            control = document.createElement('textarea');
            control.name = name;
            control.hidden = true;
            node.append(control);
          }
          control.value = value.token;
          control.dispatchEvent(new Event('input', { bubbles: true }));
          control.dispatchEvent(new Event('change', { bubbles: true }));
          const widget = node.querySelector('[data-callback]');
          const callback = widget?.getAttribute('data-callback');
          if (callback) {
            const fn = (window as unknown as Record<string, unknown>)[callback];
            if (typeof fn === 'function') fn(value.token);
          }
        },
        { kind: captcha.kind, token },
      );
    }
    if (!(await form.evaluate((el) => (el as HTMLFormElement).checkValidity())))
      return failure(
        'validation_error',
        'Форма містить незаповнені або некоректні поля.',
      );
    await screenshot('before');
    const beforeText = await page.locator('body').innerText();
    const previousUrl = page.url();
    const button = form
      .locator('button:not([type]),button[type=submit],input[type=submit]')
      .first();
    const hasButton = !!(await button.count());
    if (hasButton) {
      const override = await button.evaluate((el) => ({
        action: el.getAttribute('formaction'),
        method: el.getAttribute('formmethod'),
      }));
      if (override.action)
        await http.assertAllowed(new URL(override.action, previousUrl).href);
      if (
        override.method &&
        !['get', 'post'].includes(override.method.toLowerCase())
      )
        return failure(
          'unsafe_method',
          'Непідтримуваний метод форми.',
          'skipped',
        );
    }
    try {
      await options.beforeSubmit();
    } catch (error) {
      hookError = error;
      throw error;
    }
    armed = true;
    pending = (async () => {
      if (hasButton) await button.click();
      else await form.evaluate((el) => (el as HTMLFormElement).requestSubmit());
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        responseDone,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, options.settings.timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      await page!
        .waitForLoadState('networkidle', {
          timeout: options.settings.timeoutMs,
        })
        .catch(() => {});
    })();
    await pending;
    if (routeFailure) throw routeFailure;
    const text = await page.locator('body').innerText();
    const visibleErrors = await page
      .locator(
        '[aria-invalid="true"], [role="alert"], .error, .invalid-feedback, .field-error',
      )
      .evaluateAll((els) =>
        els
          .filter(
            (el) =>
              (el as HTMLElement).offsetWidth ||
              (el as HTMLElement).offsetHeight,
          )
          .map((el) =>
            el.getAttribute('aria-invalid') === 'true'
              ? 'validation error'
              : (el.textContent?.trim() ?? ''),
          ),
      );
    const visibleError = visibleErrors.some(
      (text) => !!text && !successText.test(text),
    );
    await screenshot('after');
    if (!submitted || !submitResponse)
      return failure(
        'submission_unconfirmed',
        'Сайт не підтвердив надсилання форми.',
      );
    if (
      submitResponse.status >= 400 ||
      visibleError ||
      errorText.test(submitResponse.body) ||
      (errorText.test(text) && text !== beforeText) ||
      /"(?:success|ok)"\s*:\s*false|"errors?"\s*:\s*(?:"[^"\s]|\{\s*"|\[\s*[^\]])/i.test(
        submitResponse.body,
      )
    )
      return failure(
        'validation_error',
        'Сайт відхилив форму або повернув помилку перевірки.',
      );
    const reset = (await form.count())
      ? await form
          .locator('textarea,input')
          .evaluateAll((els) =>
            els.some(
              (el) =>
                /message|comment|повідом|сообщ/i.test(
                  (el as HTMLInputElement).name,
                ) && !(el as HTMLInputElement).value,
            ),
          )
      : false;
    if (
      (successText.test(text) && text !== beforeText) ||
      reset ||
      page.url() !== previousUrl ||
      (submitResponse.xhr &&
        submitResponse.status >= 200 &&
        submitResponse.status < 300)
    )
      return { status: 'sent', evidence };
    return failure(
      'submission_unconfirmed',
      'Сайт не підтвердив надсилання форми.',
    );
  } catch (error) {
    if (error === hookError) throw error;
    if (error instanceof SiteUnavailable)
      return failure(
        error.code,
        error.reasonUk,
        ['unsafe_url', 'robots_denied'].includes(error.code)
          ? 'skipped'
          : 'failed',
      );
    return failure(
      'browser_error',
      'Не вдалося заповнити або надіслати форму.',
    );
  } finally {
    await pending.catch(() => {});
    try {
      await screenshot('before');
      await screenshot('after');
    } finally {
      await browser?.close();
    }
  }
}
