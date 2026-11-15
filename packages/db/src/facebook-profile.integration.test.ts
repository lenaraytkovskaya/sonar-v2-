import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { parseSocialProfile, socialTarget } from '@sonar/core';

const enabled = process.env.RUN_DB_TESTS === '1';
it.skipIf(!enabled)(
  'round-trips friends, unknown post dates and refreshed provenance without retaining stale facts',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { getCompanySocial, saveSocialProfile } = await import('./social.js');
    const id = randomUUID();
    const target = socialTarget('https://facebook.com/202020202020202/')!;
    const foundAt = new Date('2026-01-02T10:00:00Z');
    const profile = {
      ...parseSocialProfile('', target, 'GB'),
      method: 'session' as const,
      friendsCount: 73,
      followers: 19,
      posts: [
        { date: null, url: 'https://www.facebook.com/photo/?fbid=SYNTHETIC' },
      ],
    };
    try {
      await sonarPool.query(
        "insert into companies(id,place_id,name,country_code) values($1::uuid,$1::uuid::text,'Synthetic profile','GB')",
        [id],
      );
      await saveSocialProfile(
        sonarPool,
        [id],
        target,
        { ...profile, lastPostAt: '2019-07-12T00:00:00Z' },
        new Date('2026-01-01T10:00:00Z'),
      );
      await saveSocialProfile(sonarPool, [id], target, profile, foundAt);
      const { profiles } = await getCompanySocial(id);
      expect(profiles).toHaveLength(1);
      expect(profiles[0]).toMatchObject({
        profile: {
          friendsCount: 73,
          followers: 19,
          lastPostAt: null,
          posts: profile.posts,
          method: 'session',
        },
        sourceUrl: target.canonicalUrl,
        foundAt,
      });
      const { rows } = await sonarPool.query(
        "select source,source_url,found_at from company_facts where company_id=$1 and kind='social_profile'",
        [id],
      );
      expect(rows).toEqual([
        {
          source: 'facebook',
          source_url: target.canonicalUrl,
          found_at: foundAt,
        },
      ]);
    } finally {
      await sonarPool.query('delete from company_facts where company_id=$1', [
        id,
      ]);
      await sonarPool.query('delete from companies where id=$1', [id]);
    }
  },
);

afterAll(async () => {
  if (enabled) {
    const { sonarPool, registryPool } = await import('./index.js');
    await Promise.all([sonarPool.end(), registryPool.end()]);
  }
});
