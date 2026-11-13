import { describe, expect, it, vi } from 'vitest';
import {
  EmailSendError,
  messageStatusForMode,
  nextSendTime,
  sendResendEmail,
} from './email.js';

const message = {
  from: 'sonar@example.test',
  to: 'recipient@example.test',
  subject: 'Hello',
  body: '<script>\n& text',
  idempotencyKey: 'test-key',
};
describe('Resend transport', () => {
  it('sends the stable provider key, plain text, escaped HTML and unsubscribe header', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: 'provider-1' }));
    expect(await sendResendEmail(message, 'stub-token', fetcher)).toBe(
      'provider-1',
    );
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(request?.headers).toMatchObject({ 'Idempotency-Key': 'test-key' });
    expect(JSON.parse(request?.body as string)).toMatchObject({
      text: message.body,
      html: '<div>&lt;script&gt;<br>&amp; text</div>',
      headers: { 'List-Unsubscribe': '<mailto:sonar@example.test>' },
    });
  });
  it.each([
    [400, false],
    [401, false],
    [422, false],
    [429, true],
    [409, true],
    [500, true],
    [503, true],
  ])(
    'classifies HTTP %i without leaking provider response',
    async (status, retryable) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response('private recipient data', { status: status as number }),
        );
      await expect(
        sendResendEmail(message, 'stub', fetcher),
      ).rejects.toMatchObject({ code: `resend_${status}`, retryable });
    },
  );
  it('retains uncertainty for network failure or malformed success', async () => {
    await expect(
      sendResendEmail(
        message,
        'stub',
        vi.fn().mockRejectedValue(new Error('secret')),
      ),
    ).rejects.toMatchObject({ retryable: true, code: 'resend_network' });
    await expect(
      sendResendEmail(
        message,
        'stub',
        vi.fn().mockResolvedValue(Response.json({})),
      ),
    ).rejects.toMatchObject({ retryable: true, code: 'resend_response' });
    const fetcher = vi.fn();
    await expect(sendResendEmail(message, '', fetcher)).rejects.toBeInstanceOf(
      EmailSendError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
describe('sending schedule and campaign modes', () => {
  const hours = { start: 9, end: 18, days: [1, 2, 3, 4, 5] };
  const next = (value: string, timezone = 'Europe/Warsaw', window = hours) =>
    nextSendTime(new Date(value), timezone, window).toISOString();
  it('keeps current instant in hours, moves past close/weekend, and honors gap', () => {
    expect(next('2026-11-12T08:15:23.123Z')).toBe('2026-11-12T08:15:23.123Z');
    expect(next('2026-11-13T17:00:00Z')).toBe('2026-11-16T08:00:00.000Z');
    expect(
      nextSendTime(
        new Date('2026-11-12T08:00:00Z'),
        'Europe/Warsaw',
        hours,
        new Date('2026-11-12T08:02:30Z'),
      ).toISOString(),
    ).toBe('2026-11-12T08:02:30.000Z');
  });
  it('handles DST and non-hour offsets', () => {
    expect(next('2026-03-27T17:00:00Z')).toBe('2026-03-30T07:00:00.000Z');
    expect(next('2026-10-23T16:00:00Z')).toBe('2026-10-26T08:00:00.000Z');
    expect(next('2026-11-12T03:00:00Z', 'Asia/Kolkata')).toBe(
      '2026-11-12T03:30:00.000Z',
    );
  });
  it('fails closed on invalid hours/timezone', () => {
    expect(() => next('2026-11-12T08:00:00Z', 'invalid')).toThrow(
      EmailSendError,
    );
    expect(() =>
      next('2026-11-12T08:00:00Z', 'UTC', { ...hours, days: [] }),
    ).toThrow(EmailSendError);
  });
  it('requires manual action and never bypasses approval', () => {
    expect(messageStatusForMode('manual')).toBe('draft');
    expect(messageStatusForMode('manual', true)).toBe('queued');
    expect(messageStatusForMode('approval')).toBe('awaiting_approval');
    expect(messageStatusForMode('approval', true)).toBe('awaiting_approval');
    expect(messageStatusForMode('auto')).toBe('queued');
  });
});

it('forwards RFC email threading headers alongside unsubscribe metadata', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ id: 'provider' }));
  const headers = {
    'Message-ID': '<sonar-task@example.test>',
    'In-Reply-To': '<parent@example.test>',
    References: '<parent@example.test>',
  };
  await sendResendEmail({ ...message, headers }, 'stub-token', fetcher);
  expect(
    JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).headers,
  ).toMatchObject({
    ...headers,
    'List-Unsubscribe': '<mailto:sonar@example.test>',
  });
});
