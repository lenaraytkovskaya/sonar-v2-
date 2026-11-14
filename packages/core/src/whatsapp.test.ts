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
describe('read-only session webhook diagnostics', () => {
  const hook = {
    url: 'http://web:3000/api/webhooks/waha',
    events: ['message'],
    customHeaders: [{ name: 'x-api-key', value: 'private-test-key' }],
  };
  it.each([
    'WORKING',
    'STOPPED',
    'STARTING',
    'SCAN_QR_CODE',
    'FAILED',
    'PASSKEY_REQUIRED',
    'PASSKEY_CONFIRMATION_REQUIRED',
  ])(
    'reports %s without exposing session details or claiming a global webhook is absent',
    async (status) => {
      expect(
        await adapter(fake({ status, config: null })).diagnoseWebhook(),
      ).toMatchObject({
        scope: 'session_config_only',
        sessionState: status,
        providerError: 'none',
        expectedUrlConfigured: false,
        messageEventConfigured: false,
        apiKeyMatches: false,
        webhookReachability: 'not_checked',
      });
    },
  );
  it.each([{ status: ['WORKING'] }, { status: { value: 'WORKING' } }])(
    'rejects a non-string session status: %j',
    async (response) => {
      expect(await adapter(fake(response)).diagnoseWebhook()).toMatchObject({
        providerReachability: 'reachable',
        providerError: 'invalid_response',
        sessionState: 'unknown',
        expectedUrlConfigured: 'unknown',
        messageEventConfigured: 'unknown',
        apiKeyMatches: 'unknown',
      });
    },
  );
  it.each([
    [[hook], true, true, true],
    [[{ ...hook, events: ['*'] }], true, true, true],
    [[], false, false, false],
    [[{ ...hook, url: `${hook.url}/wrong` }], false, false, false],
    [[{ ...hook, events: ['message.any'] }], true, false, false],
    [[{ ...hook, customHeaders: null }], true, true, false],
    [
      [{ ...hook, customHeaders: [{ name: 'X-Api-Key', value: 'wrong' }] }],
      true,
      true,
      false,
    ],
    [
      [
        { ...hook, events: ['session.status'] },
        { ...hook, url: 'http://other' },
      ],
      true,
      false,
      false,
    ],
    [
      [
        {
          ...hook,
          customHeaders: [
            ...hook.customHeaders,
            { name: 'X-Api-Key', value: 'wrong' },
          ],
        },
      ],
      true,
      true,
      false,
    ],
  ])(
    'matches URL, event and key on the same hook: %j',
    async (webhooks, url, event, key) => {
      const network = fake({
        ...working,
        config: { webhooks, proxy: 'private-proxy' },
        raw: 'private-data',
      });
      const diagnostic = await adapter(network).diagnoseWebhook();
      expect(diagnostic).toEqual({
        scope: 'session_config_only',
        webhookReachability: 'not_checked',
        providerReachability: 'reachable',
        providerError: 'none',
        sessionState: 'WORKING',
        expectedUrlConfigured: url,
        messageEventConfigured: event,
        apiKeyMatches: key,
      });
      expect(network).toHaveBeenCalledTimes(1);
      expect(network.mock.calls[0]).toEqual([
        'http://waha:3000/api/sessions/default',
        expect.objectContaining({ method: 'GET', body: undefined }),
      ]);
      expect(JSON.stringify(diagnostic)).not.toMatch(
        /private|380671|Team|http:|headers|config"/i,
      );
    },
  );
  it.each([
    [
      new Response('private-key', { status: 401 }),
      'reachable',
      'unauthorized',
      'unknown',
    ],
    [
      new Response('private-key', { status: 403 }),
      'reachable',
      'unauthorized',
      'unknown',
    ],
    [
      new Response('private-key', { status: 404 }),
      'reachable',
      'session_missing',
      'missing',
    ],
    [
      new Response('private-key', { status: 429 }),
      'reachable',
      'rate_limited',
      'unknown',
    ],
    [
      new Response('private-key', { status: 500 }),
      'reachable',
      'provider_error',
      'unknown',
    ],
    [new Error('private-key'), 'unreachable', 'provider_error', 'unknown'],
    [new Response('private-key'), 'reachable', 'invalid_response', 'unknown'],
    [{ status: 'private-key' }, 'reachable', 'invalid_response', 'unknown'],
    [
      { ...working, config: { webhooks: 'private-key' } },
      'reachable',
      'invalid_response',
      'WORKING',
    ],
  ])(
    'classifies failures without exposing provider content: %j',
    async (response, reachability, error, state) => {
      const diagnostic = await adapter(fake(response)).diagnoseWebhook();
      expect(diagnostic).toMatchObject({
        providerReachability: reachability,
        providerError: error,
        sessionState: state,
        expectedUrlConfigured: 'unknown',
        apiKeyMatches: 'unknown',
      });
      expect(JSON.stringify(diagnostic)).not.toContain('private');
    },
  );
  it('does not request WAHA when the backend key is absent', async () => {
    const network = fake();
    expect(
      await createWhatsAppAdapter({ apiKey: '' }, network).diagnoseWebhook(),
    ).toMatchObject({
      providerReachability: 'not_checked',
      providerError: 'not_configured',
      apiKeyMatches: 'unknown',
    });
    expect(network).not.toHaveBeenCalled();
  });
});
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
