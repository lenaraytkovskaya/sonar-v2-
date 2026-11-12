import { expect, it, vi } from 'vitest';
vi.mock('@sonar/db/email', () => ({ sendEmailMessage: vi.fn() }));
import { runTelegramSend } from './telegram.js';
it('pauses missing Telegram credentials with a safe actionable reason', async () => {
  const id = process.env.TELEGRAM_API_ID,
    hash = process.env.TELEGRAM_API_HASH;
  delete process.env.TELEGRAM_API_ID;
  delete process.env.TELEGRAM_API_HASH;
  try {
    expect(await runTelegramSend({ messageId: 'none' }, 'task')).toEqual({
      status: 'paused',
      reasonCode: 'telegram_keys_missing',
      reasonUk: 'Додайте TELEGRAM_API_ID і TELEGRAM_API_HASH на сервері',
    });
  } finally {
    if (id !== undefined) process.env.TELEGRAM_API_ID = id;
    if (hash !== undefined) process.env.TELEGRAM_API_HASH = hash;
  }
});
