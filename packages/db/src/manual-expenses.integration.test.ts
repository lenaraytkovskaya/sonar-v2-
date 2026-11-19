import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';

const enabled = process.env.RUN_DB_TESTS === '1';
const created: string[] = [];
let userId: string | undefined;
let previousRates: { value: unknown } | undefined;
let previousDays: { value: unknown } | undefined;

it.skipIf(!enabled)(
  'snapshots rates, keeps manual totals separate, reminds about renewals and archives without deletion',
  async () => {
    const { sonarPool } = await import('./index.js');
    const expenses = await import('./manual-expenses.js');
    const { financeMetrics } = await import('./metrics.js');
    const { rows: settings } = await sonarPool.query(
      'select key,value from settings where key=any($1::text[])',
      [['finance.rates', 'finance.renewal_reminder_days']],
    );
    previousRates = settings.find((row) => row.key === 'finance.rates');
    previousDays = settings.find(
      (row) => row.key === 'finance.renewal_reminder_days',
    );
    const before = await financeMetrics('2099-01');
    try {
      await sonarPool.query(
        "insert into settings(key,value) values('finance.rates',$1::jsonb),('finance.renewal_reminder_days','3'::jsonb) on conflict(key) do update set value=excluded.value",
        [JSON.stringify({ USD: 1, UAH: 0.024, EUR: 1.08 })],
      );
      const { rows: users } = await sonarPool.query(
        "insert into users(email,name,password_hash) values($1,'Expenses','unusable') returning id",
        [`${randomUUID()}@example.invalid`],
      );
      userId = users[0].id;
      const first = await expenses.createManualExpense(
        {
          title: 'Test proxy',
          category: 'proxy',
          amount: 1000,
          currency: 'UAH',
          paidOn: '2099-01-05',
          paidUntil: '2099-01-10',
          accountId: null,
          note: '',
        },
        userId!,
      );
      created.push(first!.id);
      expect(Number(first!.amount_usd)).toBe(24);
      expect(Number(first!.rate_used)).toBe(0.024);
      expect(await expenses.manualExpenseReminders('2099-01-07')).toMatchObject(
        {
          reminderDays: 3,
          reminders: [{ id: first!.id, status: 'upcoming' }],
        },
      );
      expect(await expenses.manualExpenseReminders('2099-01-11')).toMatchObject(
        {
          reminders: [{ id: first!.id, status: 'overdue' }],
        },
      );

      await sonarPool.query(
        "update settings set value=$1::jsonb where key='finance.rates'",
        [JSON.stringify({ USD: 1, UAH: 0.03, EUR: 1.2 })],
      );
      const renewed = await expenses.continueManualExpense(
        first!.id,
        1200,
        'UAH',
        '2099-01-10',
        '2099-02-10',
        userId!,
      );
      created.push(renewed!.id);
      expect(Number(renewed!.amount_usd)).toBe(36);
      expect(Number(renewed!.rate_used)).toBe(0.03);
      await expect(
        expenses.continueManualExpense(
          first!.id,
          1200,
          'UAH',
          '2099-01-10',
          '2099-02-10',
          userId!,
        ),
      ).rejects.toThrow();
      expect(
        (await expenses.manualExpenseReminders('2099-01-11')).reminders,
      ).toEqual([]);

      const rows = await expenses.listManualExpenses('2099-01');
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => Number(row.amount_usd)).sort()).toEqual([
        24, 36,
      ]);
      await expenses.archiveManualExpense(renewed!.id);
      expect(await expenses.listManualExpenses('2099-01')).toHaveLength(1);
      const after = await financeMetrics('2099-01');
      expect(after.totalUsd).toBe(before.totalUsd);
    } finally {
      await sonarPool.query(
        'delete from manual_expenses where id=any($1::uuid[])',
        [created],
      );
      if (userId)
        await sonarPool.query('delete from users where id=$1', [userId]);
      if (previousRates)
        await sonarPool.query(
          "update settings set value=$1::jsonb where key='finance.rates'",
          [JSON.stringify(previousRates.value)],
        );
      else
        await sonarPool.query("delete from settings where key='finance.rates'");
      if (previousDays)
        await sonarPool.query(
          "update settings set value=$1::jsonb where key='finance.renewal_reminder_days'",
          [JSON.stringify(previousDays.value)],
        );
      else
        await sonarPool.query(
          "delete from settings where key='finance.renewal_reminder_days'",
        );
    }
  },
  15000,
);

afterAll(async () => {
  if (enabled) {
    const { sonarPool, registryPool } = await import('./index.js');
    await Promise.all([sonarPool.end(), registryPool.end()]);
  }
});
