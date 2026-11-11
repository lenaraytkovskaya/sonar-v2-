import type { PoolClient } from 'pg';
import {
  profilesSchema,
  googlePageSchema,
  type GooglePage,
  type CampaignInput,
  type GoogleProfile,
} from '@sonar/core';
import { sonarPool } from './index.js';
import { enqueueTask, logActivity } from './tasks.js';
export type BatchConfig = CampaignInput & {
  profile: GoogleProfile;
  retentionDays: number;
};
export type PairProgress = {
  pages: number;
  token?: string;
  exhausted: boolean;
  buffer: GooglePage['places'];
  reason?: string;
};
export type Progress = Record<string, PairProgress>;
export const pairKey = (query: string, city: string) =>
  JSON.stringify([query, city]);
export const emptyProgress = (): PairProgress => ({
  pages: 0,
  exhausted: false,
  buffer: [],
});
export function resultsExhausted(
  queries: string[],
  cities: string[],
  progress: Progress,
) {
  return (
    queries.length > 0 &&
    cities.length > 0 &&
    queries.every((q) =>
      cities.every((c) => {
        const p = progress[pairKey(q, c)];
        return p?.exhausted && !p.buffer.length;
      }),
    )
  );
}
export class ContinuationUnavailable extends Error {}
// Recover only persisted evidence. Never pay for page one to reconstruct a cursor.
export async function campaignProgress(
  client: PoolClient,
  campaignId: string,
): Promise<Progress> {
  const {
    rows: [campaign],
  } = await client.query('select google_progress from campaigns where id=$1', [
    campaignId,
  ]);
  if (Object.keys(campaign.google_progress).length)
    return campaign.google_progress;
  const progress: Progress = {};
  const { rows: batches } = await client.query(
    'select * from batches where campaign_id=$1 order by number',
    [campaignId],
  );
  for (const batch of batches) {
    const pairs = batch.config.queries.flatMap((query: string) =>
      batch.config.cities.map((city: string) => ({ query, city })),
    );
    for (const [index, pair] of pairs.entries()) {
      const { rows: responses } = await client.query(
        `select s.meta->'response'->>'text' as text from tasks t join spend_events s on s.task_id=t.id where t.batch_id=$1 and t.idempotency_key like $2 and s.meta ? 'response' order by t.created_at`,
        [batch.id, `google.request:${batch.id}:${index}:%`],
      );
      if (!responses.length) {
        if (batch.requests > 0 && index <= batch.cursor.pair)
          throw new ContinuationUnavailable(
            'Немає збережених даних для продовження. Першу сторінку повторно не запитано.',
          );
        continue;
      }
      const page = googlePageSchema.parse(JSON.parse(responses.at(-1).text));
      const { rows: consumed } = await client.query(
        'select c.place_id from campaign_companies cc join companies c on c.id=cc.company_id where cc.campaign_id=$1',
        [campaignId],
      );
      const ids = new Set(consumed.map((row) => row.place_id));
      // Drop the consumed prefix, retain every unconsumed place from the paid page.
      let end = -1;
      page.places.forEach((place, i) => {
        if (ids.has(place.id)) end = i;
      });
      progress[pairKey(pair.query, pair.city)] = {
        pages: responses.length,
        token: page.nextPageToken,
        exhausted: !page.nextPageToken || responses.length >= 3,
        buffer: page.places.slice(end + 1),
      };
    }
  }
  if (batches.length)
    await client.query('update campaigns set google_progress=$2 where id=$1', [
      campaignId,
      progress,
    ]);
  return progress;
}
export async function createBatch(
  campaignId: string,
  userId: string | null,
  requestKey: string,
  fixture = false,
  queue = true,
) {
  const client = await sonarPool.connect();
  try {
    await client.query('begin');
    const {
      rows: [campaign],
    } = await client.query('select * from campaigns where id=$1 for update', [
      campaignId,
    ]);
    if (
      !campaign ||
      !campaign.cities.length ||
      !campaign.queries.length ||
      campaign.status === 'archived'
    )
      throw Error('Campaign not ready');
    const {
      rows: [existing],
    } = await client.query(
      'select * from batches where request_key=$1 and campaign_id=$2',
      [requestKey, campaignId],
    );
    if (existing) {
      await client.query('commit');
      return existing;
    }
    const progress = await campaignProgress(client, campaignId);
    if (resultsExhausted(campaign.queries, campaign.cities, progress)) {
      await client.query('commit');
      return { exhausted: true };
    }
    const { rows: settings } = await client.query(
      "select key,value from settings where key in ('google.field_profiles','retention.google_days')",
    );
    const config = Object.fromEntries(settings.map((r) => [r.key, r.value]));
    const profile = profilesSchema
      .parse(config['google.field_profiles'])
      .find((p) => p.id === campaign.field_profile);
    if (!profile) throw Error('Profile missing');
    const retentionDays = Number(config['retention.google_days']);
    if (
      !Number.isInteger(retentionDays) ||
      retentionDays < 1 ||
      retentionDays > 3650
    )
      throw Error('Invalid retention');
    const {
      rows: [batch],
    } = await client.query(
      `insert into batches(campaign_id,number,size,config,request_key,fixture) select $1,coalesce(max(number),0)+1,$2,$3,$4,$5 from batches where campaign_id=$1 returning *`,
      [
        campaignId,
        campaign.batch_size,
        { ...campaign, profile, retentionDays },
        requestKey,
        fixture,
      ],
    );
    if (queue)
      await enqueueTask(
        'google.batch',
        `google.batch:${batch.id}`,
        { batchId: batch.id },
        client,
      );
    await client.query(
      "update campaigns set status='active',updated_at=now() where id=$1",
      [campaignId],
    );
    await logActivity(
      'campaign.start',
      'campaign',
      campaignId,
      userId,
      { batchId: batch.id, fixture },
      client,
    );
    await client.query('commit');
    return batch;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}
export async function recordGooglePage(
  client: PoolClient,
  batchId: string,
  callback: (client: PoolClient) => Promise<void>,
) {
  await client.query('begin');
  try {
    await client.query('select id from batches where id=$1 for update', [
      batchId,
    ]);
    await callback(client);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
