import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@sonar/db/email', () => ({ sendEmailMessage: vi.fn() }));
vi.mock('@sonar/core/whatsapp', () => ({ whatsappAdapter: { send: vi.fn() } }));
import { sendEmailMessage } from '@sonar/db/email';
import { whatsappAdapter } from '@sonar/core/whatsapp';
import { runWhatsAppSend } from './whatsapp.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it('pauses missing WAHA credentials without an external request', async () => {
  vi.stubEnv('WAHA_URL', '');
  vi.stubEnv('WAHA_API_KEY', '');
  expect(await runWhatsAppSend({ messageId: 'none' }, 'task')).toMatchObject({
    status: 'paused',
    reasonCode: 'whatsapp_keys_missing',
  });
  expect(sendEmailMessage).not.toHaveBeenCalled();
  expect(whatsappAdapter.send).not.toHaveBeenCalled();
});
it('uses shared send guards and routes the normalized recipient through WAHA', async () => {
  vi.stubEnv('WAHA_URL', 'http://stub.invalid');
  vi.stubEnv('WAHA_API_KEY', 'stub');
  vi.mocked(whatsappAdapter.send).mockResolvedValue({
    messageId: 'waha-message',
  });
  vi.mocked(sendEmailMessage).mockImplementation(
    async (_id, _task, send, _now, _random, channel) => {
      expect(channel).toBe('whatsapp');
      expect(
        await send(
          {
            from: '',
            to: '+48500100200',
            subject: '',
            body: 'Test',
            idempotencyKey: 'stable-key',
          },
          { id: 'account', settings: { countryCode: 'PL' } },
        ),
      ).toBe('waha-message');
      return { status: 'done', result: {} };
    },
  );
  expect(await runWhatsAppSend({ messageId: 'message' }, 'task')).toEqual({
    status: 'done',
    result: {},
  });
  expect(whatsappAdapter.send).toHaveBeenCalledWith({
    accountId: 'account',
    to: '+48500100200',
    body: 'Test',
    idempotencyKey: 'stable-key',
    defaultCountry: 'PL',
  });
});
