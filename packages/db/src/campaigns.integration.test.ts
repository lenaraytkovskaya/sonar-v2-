import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'saves campaigns, logs changes and rejects invalid forms without a write',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { saveCampaign } = await import('./campaigns.js');
    const {
      rows: [user],
    } = await sonarPool.query(
      "insert into users(email,name,password_hash) values($1,'Test','unusable') returning id",
      [`${randomUUID()}@example.invalid`],
    );
    let id: string | undefined;
    try {
      const data = {
        name: 'Test campaign',
        country_code: 'PL',
        language_code: 'pl',
        cities: ['Warszawa'],
        queries: ['warsztat samochodowy'],
        offer: '',
        batch_size: 20 as const,
        budget_usd: 0.5,
        channels: {
          email: true,
          telegram: false,
          whatsapp: false,
          forms: false,
        },
        send_mode: 'approval' as const,
        scoring_weights: { website: 30 },
        status: 'draft' as const,
      };
      const saved = await saveCampaign(data, null, user.id, 'ai');
      id = saved.id;
      expect(saved.country_code).toBe('PL');
      expect(Number(saved.budget_usd)).toBe(0.5);
      await saveCampaign({ ...data, name: 'Updated' }, id!, user.id);
      await expect(
        saveCampaign({ ...data, budget_usd: -1 }, id!, user.id),
      ).rejects.toThrow();
      expect(
        (await sonarPool.query('select name from campaigns where id=$1', [id]))
          .rows[0].name,
      ).toBe('Updated');
      expect(
        (
          await sonarPool.query(
            'select action from activity_log where entity_id=$1 order by created_at',
            [id],
          )
        ).rows.map((r) => r.action),
      ).toEqual(['campaign.create', 'campaign.update']);
    } finally {
      await sonarPool.query('delete from activity_log where entity_id=$1', [
        id,
      ]);
      await sonarPool.query('delete from campaigns where id=$1', [id]);
      await sonarPool.query('delete from users where id=$1', [user.id]);
    }
  },
);
afterAll(async () => {
  if (enabled) {
    const { sonarPool, registryPool } = await import('./index.js');
    await Promise.all([sonarPool.end(), registryPool.end()]);
  }
});
