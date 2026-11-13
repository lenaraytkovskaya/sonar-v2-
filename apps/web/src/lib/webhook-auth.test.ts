import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { enqueue } = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock('@sonar/db/tasks', () => ({ enqueueTask: enqueue }));
vi.mock('@/lib/webhook-auth', () => import('./webhook-auth'));
import { verifyResendWebhook, verifyWebhookKey } from './webhook-auth';
import { POST as resend } from '../app/api/webhooks/resend/route';
import { POST as waha } from '../app/api/webhooks/waha/route';

const secret = `whsec_${Buffer.from('test-webhook-signing-secret').toString('base64')}`;
const now = 1_800_000_000;
function signed(body: string, timestamp = now, signingSecret = secret) {
  const signature = createHmac(
    'sha256',
    Buffer.from(signingSecret.slice(6), 'base64'),
  )
    .update(`event-1.${timestamp}.${body}`)
    .digest('base64');
  return new Headers({
    'svix-id': 'event-1',
    'svix-timestamp': String(timestamp),
    'svix-signature': `v1,${signature}`,
  });
}
const email = {
  type: 'email.received',
  created_at: '2027-01-15T08:00:00.000Z',
  data: { email_id: 'email-1', to: ['team@example.com'] },
};
const message = {
  event: 'message',
  session: 'account-1',
  payload: {
    id: 'message-1',
    from: '380501234567@c.us',
    fromMe: false,
    body: 'Reply',
    timestamp: now,
  },
};
const request = (body: string, headers: HeadersInit = {}) =>
  new Request('http://localhost/api/webhooks/test', {
    method: 'POST',
    body,
    headers,
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now * 1000);
  vi.stubEnv('RESEND_WEBHOOK_SECRET', secret);
  vi.stubEnv('WAHA_API_KEY', 'waha-test-secret');
  enqueue.mockResolvedValue('task-1');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('webhook authentication', () => {
  it('verifies the raw Svix payload and supports rotating v1 signatures', () => {
    const body = JSON.stringify(email);
    const headers = signed(body);
    headers.set(
      'svix-signature',
      `v2,ignored v1,invalid ${headers.get('svix-signature')}`,
    );
    expect(verifyResendWebhook(body, headers)).toBe(true);
    expect(verifyResendWebhook(`${body} `, headers)).toBe(false);
    headers.set('svix-id', 'tampered');
    expect(verifyResendWebhook(body, headers)).toBe(false);
  });
  it('rejects missing headers, wrong secrets, and stale or future timestamps', () => {
    const body = JSON.stringify(email);
    expect(verifyResendWebhook(body, new Headers())).toBe(false);
    expect(verifyResendWebhook(body, signed(body), 'whsec_d3Jvbmc=')).toBe(
      false,
    );
    for (const offset of [-301, 301])
      expect(verifyResendWebhook(body, signed(body, now + offset))).toBe(false);
    expect(verifyResendWebhook(body, signed(body), '')).toBe(false);
    expect(verifyResendWebhook(body, signed(body), 'whsec_!!!')).toBe(false);
  });
  it('rejects absent and wrong WAHA keys', () => {
    expect(verifyWebhookKey('key', 'key')).toBe(true);
    expect(verifyWebhookKey('wrong', 'key')).toBe(false);
    expect(verifyWebhookKey(null, 'key')).toBe(false);
    expect(verifyWebhookKey('', '')).toBe(false);
    expect(verifyWebhookKey('key')).toBe(false);
  });
});

describe('inbound webhook routes', () => {
  it('queues authenticated email metadata without making external requests', async () => {
    const body = JSON.stringify(email);
    expect((await resend(request(body, signed(body)))).status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith(
      'email.receive',
      'email.receive:email-1',
      {
        emailId: 'email-1',
        eventId: 'event-1',
        receivedAt: email.created_at,
        recipients: ['team@example.com'],
      },
    );
  });
  it('authenticates before parsing and fails closed without configured secrets', async () => {
    expect((await resend(request('{'))).status).toBe(401);
    expect((await waha(request('{'))).status).toBe(401);
    vi.stubEnv('RESEND_WEBHOOK_SECRET', '');
    vi.stubEnv('WAHA_API_KEY', '');
    expect((await resend(request('{}'))).status).toBe(503);
    expect((await waha(request('{}', { 'X-Api-Key': 'key' }))).status).toBe(
      503,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('rejects invalid signed JSON and malformed inbound email metadata', async () => {
    for (const body of [
      '{',
      'null',
      '{}',
      JSON.stringify({ ...email, data: {} }),
      JSON.stringify({ ...email, data: { ...email.data, to: [null] } }),
      JSON.stringify({ ...email, created_at: 'invalid' }),
    ])
      expect((await resend(request(body, signed(body)))).status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('queues WAHA messages with a stable session-specific idempotency key', async () => {
    const body = JSON.stringify(message);
    const headers = { 'X-Api-Key': 'waha-test-secret' };
    expect((await waha(request(body, headers))).status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith(
      'whatsapp.receive',
      'whatsapp.receive:["account-1","message-1"]',
      {
        session: message.session,
        id: message.payload.id,
        from: message.payload.from,
        body: 'Reply',
        timestamp: now,
      },
    );
    expect((await waha(request(body, { 'X-Api-Key': 'wrong' }))).status).toBe(
      401,
    );
  });
  it('rejects malformed WAHA JSON and payloads', async () => {
    for (const body of [
      '{',
      'null',
      '{}',
      JSON.stringify({ ...message, payload: null }),
      JSON.stringify({
        ...message,
        payload: { ...message.payload, timestamp: 'invalid' },
      }),
    ])
      expect(
        (await waha(request(body, { 'X-Api-Key': 'waha-test-secret' }))).status,
      ).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('preserves attachment-only WhatsApp messages for queued processing', async () => {
    const body = JSON.stringify({
      ...message,
      payload: { ...message.payload, body: undefined, hasMedia: true },
    });
    expect(
      (await waha(request(body, { 'X-Api-Key': 'waha-test-secret' }))).status,
    ).toBe(200);
    expect(enqueue).toHaveBeenCalledWith(
      'whatsapp.receive',
      expect.any(String),
      expect.objectContaining({ body: '', id: message.payload.id }),
    );
  });
  it('acknowledges unrelated events and outgoing WAHA echoes without queueing', async () => {
    const body = JSON.stringify({ type: 'email.delivered' });
    expect((await resend(request(body, signed(body)))).status).toBe(200);
    for (const event of [
      { event: 'session.status' },
      { ...message, payload: { ...message.payload, fromMe: true } },
    ])
      expect(
        (
          await waha(
            request(JSON.stringify(event), {
              'X-Api-Key': 'waha-test-secret',
            }),
          )
        ).status,
      ).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
