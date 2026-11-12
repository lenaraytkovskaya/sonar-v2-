import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { WhatsAppSendError, type WhatsAppSession } from '@sonar/core/whatsapp';
const enabled = process.env.RUN_DB_TESTS === '1';
let db: typeof import('./index.js'), accounts: typeof import('./whatsapp.js');
beforeAll(async () => {
  if (!enabled) return;
  db = await import('./index.js');
  accounts = await import('./whatsapp.js');
});
it.skipIf(!enabled)(
  'keeps one owner-bound WAHA session, masks phone, persists failures and never stores QR or secrets',
  async () => {
    const user = randomUUID(),
      other = randomUUID();
    const adapter = {
      start: vi.fn(async (): Promise<WhatsAppSession> => ({
        status: 'SCAN_QR_CODE',
        phone: null,
      })),
      getSession: vi.fn(async (): Promise<WhatsAppSession> => ({
        status: 'WORKING',
        phone: '+380671234567',
        name: 'Profile',
      })),
      getQr: vi.fn(async () => 'data:image/png;base64,cXItc2VjcmV0'),
      restart: vi.fn(async (): Promise<WhatsAppSession> => ({
        status: 'STARTING',
        phone: null,
      })),
      logout: vi.fn(async () => {}),
    };
    let accountId: string | undefined;
    try {
      for (const id of [user, other])
        await db.sonarPool.query(
          "insert into users(id,email,name,password_hash) values($1,$2,'WAHA test','stub')",
          [id, `${id}@invalid.test`],
        );
      const connected = await accounts.connectWhatsAppAccount(
        { name: 'WhatsApp test', dailyLimit: 10 },
        user,
        adapter,
      );
      accountId = connected.id;
      expect(connected).toMatchObject({
        status: 'qr',
        qr: 'data:image/png;base64,cXItc2VjcmV0',
      });
      await expect(
        accounts.connectWhatsAppAccount(
          { name: 'Second number', dailyLimit: 10 },
          other,
          adapter,
        ),
      ).rejects.toThrow('один номер');
      await expect(
        accounts.refreshWhatsAppAccount(accountId, other, adapter),
      ).rejects.toThrow('не знайдено');
      expect(adapter.start).toHaveBeenCalledTimes(1);
      await accounts.refreshWhatsAppAccount(accountId, user, adapter);
      let account = (await accounts.listWhatsAppAccounts()).find(
        (a) => a.id === accountId,
      )!;
      expect(account).toMatchObject({
        enabled: true,
        desiredEnabled: true,
        providerName: 'Profile',
        status: 'active',
      });
      expect(account.address).not.toContain('671234');
      expect(account).not.toHaveProperty('settings');
      await accounts.updateWhatsAppAccount(
        accountId,
        { enabled: false, dailyLimit: 4 },
        user,
      );
      await accounts.refreshWhatsAppAccount(accountId, user, adapter);
      account = (await accounts.listWhatsAppAccounts()).find(
        (a) => a.id === accountId,
      )!;
      expect(account).toMatchObject({
        enabled: false,
        desiredEnabled: false,
        status: 'active',
        dailyLimit: 4,
      });
      await db.sonarPool.query(
        "update channel_accounts set status='paused' where id=$1",
        [accountId],
      );
      await accounts.updateWhatsAppAccount(accountId, { enabled: true }, user);
      expect(
        (await accounts.listWhatsAppAccounts()).find((a) => a.id === accountId),
      ).toMatchObject({ enabled: false, status: 'failed' });
      const next = new Date(Date.now() + 3600000);
      await db.sonarPool.query(
        'update channel_accounts set next_send_at=$2 where id=$1',
        [accountId, next],
      );
      adapter.getSession.mockRejectedValueOnce(
        new WhatsAppSendError(
          'waha_unreachable',
          'Сервіс WhatsApp недоступний.',
          true,
        ),
      );
      expect(
        await accounts.refreshWhatsAppAccount(accountId, user, adapter),
      ).toMatchObject({
        status: 'failed',
        reasonUk: 'Сервіс WhatsApp недоступний.',
      });
      const failure = (
        await db.sonarPool.query(
          "select id,status,reason_uk from tasks where subject_id=$1 and status='failed'",
          [accountId],
        )
      ).rows;
      expect(failure).toEqual([
        {
          id: expect.any(String),
          status: 'failed',
          reason_uk: 'Сервіс WhatsApp недоступний.',
        },
      ]);
      const { retryTask } = await import('./tasks.js');
      expect(await retryTask(failure[0].id, user)).toBe(false);
      await accounts.restartWhatsAppAccount(accountId, user, adapter);
      await accounts.logoutWhatsAppAccount(accountId, user, adapter);
      const saved = (
        await db.sonarPool.query(
          'select settings,next_send_at,status,address from channel_accounts where id=$1',
          [accountId],
        )
      ).rows[0];
      expect(saved).toMatchObject({
        status: 'stopped',
        address: 'default',
        next_send_at: next,
      });
      expect(JSON.stringify(saved.settings)).not.toContain('cXItc2VjcmV0');
      expect(saved.settings).not.toHaveProperty('apiKey');
      await accounts.updateWhatsAppAccount(accountId, { enabled: true }, user);
      expect(
        (await accounts.listWhatsAppAccounts()).find((a) => a.id === accountId),
      ).toMatchObject({
        enabled: false,
        desiredEnabled: true,
        status: 'stopped',
      });
    } finally {
      await db.sonarPool.query(
        'delete from activity_log where user_id=any($1::uuid[])',
        [[user, other]],
      );
      if (accountId)
        await db.sonarPool.query('delete from tasks where subject_id=$1', [
          accountId,
        ]);
      await db.sonarPool.query(
        'delete from channel_accounts where owner_id=any($1::uuid[])',
        [[user, other]],
      );
      await db.sonarPool.query('delete from users where id=any($1::uuid[])', [
        [user, other],
      ]);
    }
  },
);
afterAll(async () => {
  if (!enabled) return;
  const { closeTaskQueue } = await import('./tasks.js');
  await closeTaskQueue();
  await Promise.all([db.sonarPool.end(), db.registryPool.end()]);
});
