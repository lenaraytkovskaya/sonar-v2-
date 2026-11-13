export class EmailSendError extends Error {
  constructor(
    public code: string,
    public reasonUk: string,
    public retryable: boolean,
  ) {
    super(code);
  }
}
export type EmailRequest = {
  from: string;
  to: string;
  subject: string;
  body: string;
  idempotencyKey: string;
  headers?: Record<string, string>;
};
export async function sendResendEmail(
  message: EmailRequest,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (!token)
    throw new EmailSendError(
      'resend_token',
      'Не налаштовано ключ Resend.',
      false,
    );
  const escape = (text: string) =>
    text.replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[c]!,
    );
  let response: Response;
  try {
    response = await fetcher('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': message.idempotencyKey,
      },
      body: JSON.stringify({
        from: message.from,
        to: [message.to],
        subject: message.subject,
        text: message.body,
        html: `<div>${escape(message.body).replace(/\r?\n/g, '<br>')}</div>`,
        headers: {
          'List-Unsubscribe': `<mailto:${message.from}>`,
          ...message.headers,
        },
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new EmailSendError(
      'resend_network',
      'Не вдалося отримати відповідь Resend. Повтор із тим самим ключем.',
      true,
    );
  }
  if (!response.ok) {
    const detail: unknown = await response.json().catch(() => null);
    const reason =
      detail &&
      typeof detail === 'object' &&
      'message' in detail &&
      typeof detail.message === 'string'
        ? detail.message.slice(0, 300)
        : '';
    const hint =
      response.status === 403 && /domain/i.test(reason)
        ? ' Домен адреси відправника не підтверджено в цьому акаунті Resend.'
        : response.status === 401 || /api key/i.test(reason)
          ? ' Перевірте ключ Resend на сервері.'
          : '';
    throw new EmailSendError(
      `resend_${response.status}`,
      `Resend відхилив запит (HTTP ${response.status}).${hint}${reason ? ` Відповідь Resend: ${reason}` : ''}`,
      response.status === 429 ||
        response.status === 409 ||
        response.status >= 500,
    );
  }
  const result: unknown = await response.json().catch(() => null);
  if (
    !result ||
    typeof result !== 'object' ||
    !('id' in result) ||
    typeof result.id !== 'string' ||
    !result.id
  )
    throw new EmailSendError(
      'resend_response',
      'Resend не повернув ідентифікатор листа. Потрібна перевірка результату.',
      true,
    );
  return result.id;
}
export function messageStatusForMode(
  mode: 'manual' | 'approval' | 'auto',
  submit = false,
) {
  return mode === 'approval'
    ? 'awaiting_approval'
    : mode === 'auto' || submit
      ? 'queued'
      : 'draft';
}
// Days use JavaScript weekday numbers: Sunday = 0. Hours are local wall-clock hours.
export type SendHours = { start: number; end: number; days: number[] };
export function nextSendTime(
  now: Date,
  timeZone: string,
  hours: SendHours,
  notBefore = now,
): Date {
  if (
    !hours ||
    !Number.isInteger(hours.start) ||
    !Number.isInteger(hours.end) ||
    hours.start < 0 ||
    hours.start > 23 ||
    hours.end < 1 ||
    hours.end > 24 ||
    hours.start >= hours.end ||
    !Array.isArray(hours.days) ||
    !hours.days.length ||
    hours.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  )
    throw new EmailSendError(
      'send_hours',
      'Некоректні робочі години відправлення.',
      false,
    );
  let format: Intl.DateTimeFormat;
  try {
    if (!timeZone) throw new Error('missing timezone');
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: 'numeric',
      hourCycle: 'h23',
    });
  } catch {
    throw new EmailSendError(
      'send_timezone',
      'Налаштуйте часовий пояс країни кампанії.',
      false,
    );
  }
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let candidate = new Date(Math.max(now.getTime(), notBefore.getTime()));
  if (!Number.isFinite(candidate.getTime()))
    throw new EmailSendError(
      'send_date',
      'Некоректна дата відправлення.',
      false,
    );
  // Walk actual instants, so DST gaps and repeated wall-clock hours remain correct.
  for (let minute = 0; minute <= 8 * 24 * 60; minute++) {
    const parts = format.formatToParts(candidate);
    const hour = Number(parts.find((part) => part.type === 'hour')!.value);
    const day = weekdays.indexOf(
      parts.find((part) => part.type === 'weekday')!.value,
    );
    if (hours.days.includes(day) && hour >= hours.start && hour < hours.end)
      return candidate;
    candidate = new Date(
      Math.floor(candidate.getTime() / 60000) * 60000 + 60000,
    );
  }
  throw new EmailSendError(
    'send_hours',
    'Не знайдено наступного робочого вікна.',
    false,
  );
}
