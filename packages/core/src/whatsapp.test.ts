import { describe, expect, it, vi } from 'vitest';
import {
  createWhatsAppAdapter,
  normalizeWhatsAppRecipient,
  whatsappMessageId,
} from './whatsapp.js';

const working = {
  status: 'WORKING',
  me: { id: '380671234567:1@c.us', pushName: 'Team' },
};
const input = {
  accountId: 'account',
  to: '+380671234567',
  body: 'Hello',
  idempotencyKey: 'once',
};
function fake(...responses: (object | Response | Error)[]) {
  return vi.fn<typeof fetch>(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next instanceof Response ? next : Response.json(next);
  });
}
const adapter = (network: typeof fetch) =>
  createWhatsAppAdapter({ apiKey: 'private-test-key' }, network);
describe('WhatsApp WAHA Core adapter', () => {
  it('normalizes wa.me, international numbers and campaign countries', () => {
    expect(
      normalizeWhatsAppRecipient('https://wa.me/48512345678?text=Hello'),
    ).toBe('+48512345678');
    expect(normalizeWhatsAppRecipient('380671234567')).toBe('+380671234567');
    expect(normalizeWhatsAppRecipient('067 123 45 67', 'UA')).toBe(
      '+380671234567',
    );
    expect(normalizeWhatsAppRecipient('512 345 678', 'PL')).toBe(
      '+48512345678',
    );
    for (const value of [
      'garbage',
      'https://evil.test/380671234567',
      'https://wa.me/380671234567/group',
      '@group',
    ])
      expect(normalizeWhatsAppRecipient(value)).toBeNull();
  });
  it('checks session and existence before sending to provider-resolved chat id', async () => {
    const network = fake(
      working,
      { numberExists: true, chatId: '12345678@lid' },
      { id: 'provider-id' },
    );
    await expect(adapter(network).send(input)).resolves.toEqual({
      messageId: 'provider-id',
    });
    expect(network.mock.calls[1][0]).toContain(
      'phone=380671234567&session=default',
    );
    expect(JSON.parse(String(network.mock.calls[2][1]?.body))).toEqual({
      session: 'default',
      chatId: '12345678@lid',
      text: 'Hello',
    });
    expect(network.mock.calls[2][1]?.headers).toMatchObject({
      'X-Api-Key': 'private-test-key',
    });
  });
  it('never sends to nonexistent contacts or an inactive session', async () => {
    const network = fake(working, { numberExists: false });
    await expect(adapter(network).send(input)).rejects.toMatchObject({
      unavailable: true,
      retryable: false,
    });
    expect(network).toHaveBeenCalledTimes(2);
    const inactive = fake({ status: 'SCAN_QR_CODE' });
    await expect(adapter(inactive).send(input)).rejects.toMatchObject({
      sessionInactive: true,
    });
    expect(inactive).toHaveBeenCalledTimes(1);
  });
  it.each([429, 500, 503])(
    'retries explicit HTTP %s with non-JSON body',
    async (status) => {
      const network = fake(
        working,
        { numberExists: true, chatId: '380671234567@c.us' },
        new Response('Unavailable', {
          status,
          headers: { 'Retry-After': '43' },
        }),
      );
      await expect(adapter(network).send(input)).rejects.toMatchObject({
        retryable: true,
        ...(status === 429 ? { retryAfterSeconds: 43 } : {}),
      });
    },
  );
  it('pauses ambiguous send transport failure but retries pre-send network failure', async () => {
    const contact = { numberExists: true, chatId: '380671234567@c.us' };
    await expect(
      adapter(fake(working, contact, new Error('private credentials'))).send(
        input,
      ),
    ).rejects.toMatchObject({ code: 'send_ambiguous', retryable: false });
    await expect(
      adapter(fake(new Error('offline'))).send(input),
    ).rejects.toMatchObject({ code: 'waha_unreachable', retryable: true });
    await expect(
      adapter(fake(working, contact, {})).send(input),
    ).rejects.toMatchObject({ code: 'send_ambiguous', retryable: false });
  });
  it('creates only default, reads QR safely, extracts profile, and stops before logout', async () => {
    const network = fake(
      new Response('{}', { status: 404 }),
      {},
      { status: 'SCAN_QR_CODE' },
      { mimetype: 'image/png', data: 'cXItcG5n' },
    );
    const client = adapter(network);
    await expect(client.start()).resolves.toMatchObject({
      status: 'SCAN_QR_CODE',
    });
    await expect(client.getQr()).resolves.toBe(
      'data:image/png;base64,cXItcG5n',
    );
    expect(JSON.parse(String(network.mock.calls[1][1]?.body))).toMatchObject({
      name: 'default',
      start: true,
      config: {
        webhooks: [
          {
            url: 'http://web:3000/api/webhooks/waha',
            events: ['message'],
            customHeaders: [{ name: 'X-Api-Key', value: 'private-test-key' }],
          },
        ],
      },
    });
    await expect(adapter(fake(working)).getSession()).resolves.toEqual({
      status: 'WORKING',
      phone: '+380671234567',
      name: 'Team',
    });
    const logout = fake(working, {}, {});
    await adapter(logout).logout();
    expect(
      logout.mock.calls.map(([url]) => String(url).split('/api/')[1]),
    ).toEqual([
      'sessions/default',
      'sessions/default/stop',
      'sessions/default/logout',
    ]);
  });
  it('keeps rejected credentials and invalid QR content out of errors', async () => {
    await expect(
      adapter(
        fake(new Response('private-test-key', { status: 401 })),
      ).getSession(),
    ).rejects.toMatchObject({ code: 'waha_auth', retryable: false });
    await expect(
      adapter(fake({ mimetype: 'text/html', data: '<script>' })).getQr(),
    ).rejects.toMatchObject({ code: 'waha_qr' });
  });
  it('recreates a missing default session on restart', async () => {
    const network = fake(
      new Response('{}', { status: 404 }),
      {},
      { status: 'STARTING' },
    );
    await expect(adapter(network).restart()).resolves.toMatchObject({
      status: 'STARTING',
    });
    expect(String(network.mock.calls[1][0])).toBe(
      'http://waha:3000/api/sessions',
    );
  });
});

it('resolves LIDs to phone when available without inventing phone from LID digits', async () => {
  const network = fake(
    { lid: '12345678@lid', pn: '380671234567@c.us' },
    { lid: '12345678@lid', pn: null },
  );
  const client = adapter(network);
  expect(await client.phoneByLid('12345678@lid')).toBe('+380671234567');
  expect(await client.phoneByLid('12345678@lid')).toBeNull();
  expect(network.mock.calls[0]?.[0]).toBe(
    'http://waha:3000/api/default/lids/12345678%40lid',
  );
  expect(normalizeWhatsAppRecipient('whatsapp:lid:12345678')).toBe(
    'whatsapp:lid:12345678',
  );
});
it('replies directly to an inbound LID without treating it as a phone', async () => {
  const network = fake(working, { id: 'provider' });
  await adapter(network).send({ ...input, to: 'whatsapp:lid:12345678' });
  expect(network).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(network.mock.calls[1]?.[1]?.body))).toEqual({
    session: 'default',
    chatId: '12345678@lid',
    text: 'Hello',
  });
});
describe('WAHA sendText response', () => {
  it('reads the message id from every engine format', () => {
    expect(whatsappMessageId({ id: 'true_1@c.us_A' })).toBe('true_1@c.us_A');
    expect(whatsappMessageId({ id: { _serialized: 'true_1@c.us_B' } })).toBe(
      'true_1@c.us_B',
    );
    expect(whatsappMessageId({ key: { id: '3EB0C' }, message: {} })).toBe(
      '3EB0C',
    );
    expect(whatsappMessageId({ _data: { key: { id: '3EB0D' } } })).toBe(
      '3EB0D',
    );
    expect(whatsappMessageId({})).toBeNull();
  });
});
