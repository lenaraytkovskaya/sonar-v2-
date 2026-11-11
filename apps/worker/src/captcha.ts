import { PaidHttpError, type PaidResponse } from '@sonar/core';

export type FormCaptcha = {
  kind: 'recaptcha' | 'hcaptcha' | 'turnstile';
  siteKey: string;
  url: string;
};

// https://2captcha.com/api-docs/create-task and /get-task-result
export async function solveTwoCaptcha(
  captcha: FormCaptcha,
  key: string,
  options: { pollMs: number; timeoutMs: number },
  transport: typeof fetch = fetch,
  wait = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
): Promise<PaidResponse> {
  const deadline = Date.now() + options.timeoutMs;
  const call = async (method: string, payload: Record<string, unknown>) => {
    const response = await transport(`https://api.2captcha.com/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: key, ...payload }),
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    // Transport failures are billing-uncertain: a paid task may already exist.
    if (!response.ok) throw Error('Не вдалося звірити результат 2Captcha.');
    return (await response.json()) as {
      errorId: number;
      taskId?: number;
      status?: string;
      cost?: string;
      solution?: { gRecaptchaResponse?: string; token?: string };
    };
  };
  const created = await call('createTask', {
    task: {
      type: {
        recaptcha: 'RecaptchaV2TaskProxyless',
        hcaptcha: 'HCaptchaTaskProxyless',
        turnstile: 'TurnstileTaskProxyless',
      }[captcha.kind],
      websiteURL: captcha.url,
      websiteKey: captcha.siteKey,
    },
  });
  if (created.errorId) throw new PaidHttpError(400);
  if (!created.taskId) throw Error('2Captcha не повернула номер завдання.');
  while (Date.now() < deadline) {
    await wait(options.pollMs);
    if (Date.now() >= deadline) break;
    const result = await call('getTaskResult', { taskId: created.taskId });
    if (result.errorId) throw Error('Потрібно звірити витрати 2Captcha.');
    if (result.status !== 'ready') continue;
    const costUsd = Number(result.cost);
    if (result.cost === undefined || !Number.isFinite(costUsd) || costUsd < 0)
      throw Error('2Captcha не повернула фактичну вартість.');
    return {
      id: String(created.taskId),
      model: captcha.kind,
      text: result.solution?.gRecaptchaResponse ?? result.solution?.token ?? '',
      costUsd,
      units: 1,
      costBasis: 'provider_reported',
    };
  }
  throw Error('Час очікування 2Captcha вичерпано; перевірте списання.');
}
