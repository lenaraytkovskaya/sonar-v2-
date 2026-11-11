import { sonarPool } from '@sonar/db';
import { runBudgetedRequest } from '@sonar/db/budget';
import { sendFormMessage } from '@sonar/db/forms';
import { sendWebsiteForm } from './form-browser.js';
import { solveTwoCaptcha, type FormCaptcha } from './captcha.js';

export async function runFormSend(
  input: { messageId: string },
  taskId: string,
) {
  return sendFormMessage(input.messageId, taskId, async (request, hooks) => {
    const { rows } = await sonarPool.query(
      "select key,value from settings where key like 'scanner.%' or key like 'captcha.%'",
    );
    const config = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    const settings = {
      timeoutMs: Number(config['scanner.timeout_ms']),
      maxBytes: Number(config['scanner.max_bytes']),
      maxPages: Number(config['scanner.max_pages']),
      userAgent: String(config['scanner.user_agent'] ?? ''),
    };
    if (
      !settings.userAgent ||
      ![settings.timeoutMs, settings.maxBytes, settings.maxPages].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      )
    )
      return {
        status: 'failed',
        reasonCode: 'form_config_invalid',
        reasonUk: 'Перевірте налаштування сканера сайтів.',
      };
    const solveCaptcha =
      config['captcha.provider'] === '2captcha' &&
      process.env.TWOCAPTCHA_API_KEY
        ? async (captcha: FormCaptcha) => {
            const {
              rows: [service],
            } = await sonarPool.query(
              "select unit_price_usd from services where code='twocaptcha'",
            );
            const estimate = Number(service?.unit_price_usd);
            const pollMs = Number(config['captcha.poll_ms']);
            const timeoutMs = Number(config['captcha.timeout_ms']);
            if (
              !Number.isFinite(estimate) ||
              estimate <= 0 ||
              !Number.isSafeInteger(pollMs) ||
              pollMs < 5000 ||
              !Number.isSafeInteger(timeoutMs) ||
              timeoutMs <= pollMs
            )
              throw Error('Перевірте тариф та налаштування 2Captcha.');
            const result = await runBudgetedRequest(
              'twocaptcha',
              estimate,
              taskId,
              () =>
                solveTwoCaptcha(captcha, process.env.TWOCAPTCHA_API_KEY!, {
                  pollMs,
                  timeoutMs,
                }),
            );
            if (!result.text) throw Error('2Captcha не повернула розв’язання.');
            return result.text;
          }
        : undefined;
    return sendWebsiteForm(request, { ...hooks, settings, solveCaptcha });
  });
}
