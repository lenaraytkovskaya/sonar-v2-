import { expect, it } from 'vitest';
process.env.DATABASE_URL ??=
  'postgres://test:local-test-only@localhost:55433/sonar';
process.env.REGISTRY_DATABASE_URL ??=
  'postgres://test:local-test-only@localhost:55433/registry';
const { ensureFormAccount } = await import('./email.js');

it('creates one internal form account under the transaction lock', async () => {
  let created: { id: string } | undefined;
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes("select id from channel_accounts where channel='form'"))
        return { rows: created ? [created] : [] };
      if (sql.includes("key='send.form_company_daily_limit'"))
        return { rows: [{ value: '7' }] };
      if (sql.includes('insert into channel_accounts')) {
        created = { id: 'generated-form-account' };
        return { rows: [created] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  expect(await ensureFormAccount(client)).toEqual({
    id: 'generated-form-account',
  });
  expect(await ensureFormAccount(client)).toEqual({
    id: 'generated-form-account',
  });
  expect(
    statements.filter((sql) => sql.includes('insert into channel_accounts')),
  ).toHaveLength(1);
  expect(statements[0]).toContain('pg_advisory_xact_lock');
});
