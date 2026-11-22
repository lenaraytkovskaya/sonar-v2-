import type { PoolClient } from 'pg';
import {
  profilesSchema,
  googlePageSchema,
  googleSearchPairs,
  googlePairKey,
  normalizeCampaignLanguages,
  plannedGoogleRequests,
  type GooglePage,
  type CampaignInput,
  type GoogleProfile,
} from '@sonar/core';
import { checkGooglePlanBudget } from './budget.js';
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
export const pairKey = googlePairKey;
export const emptyProgress = (): PairProgress => ({
  pages: 0,
  exhausted: false,
  buffer: [],
});
export function resultsExhausted(
  queries: string[],
  cities: string[],
  progress: Progress,
  languages: string[],
) {
  const pairs = googleSearchPairs({
    queries,
    cities,
    language_codes: languages,
  });
  return (
    pairs.length > 0 &&
    pairs.every((pair) => {
      const state = progress[pairKey(pair.query, pair.city, pair.language)];
      return state?.exhausted && !state.buffer.length;
    })
  );
}
export class ContinuationUnavailable extends Error {}
export class CampaignProductRequired extends Error {
  constructor() {
    super('Оберіть продукт');
  }
}
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
  const { rows: consumed } = await client.query(
    'select c.place_id from campaign_companies cc join companies c on c.id=cc.company_id where cc.campaign_id=$1',
    [campaignId],
  );
  const ids = new Set(consumed.map((row) => row.place_id));
  const unavailable = () =>
    new ContinuationUnavailable(
      'Немає збережених даних для продовження. Першу сторінку повторно не запитано.',
    );
  for (const batch of batches) {
    const pairs = googleSearchPairs(batch.config);
    const { rows: evidence } = await client.query(
      `select t.idempotency_key,t.payload,t.result,t.attempts,s.meta,s.cost_usd
       from tasks t left join spend_events s on s.task_id=t.id
       where t.batch_id=$1 and t.type='google.request'
       order by t.created_at,t.id,s.attempt`,
      [batch.id],
    );
    // Cursor position is not proof a pair was queried in this batch: previous
    // batches may already have exhausted it. Account for actual paid attempts.
    if (batch.requests > evidence.filter((row) => row.meta != null).length)
      throw unavailable();
    for (const row of evidence) {
      if (!row.meta) {
        if (row.result?.billingPending || row.attempts > 0) throw unavailable();
        continue;
      }
      if (!row.meta.response) {
        const status = row.meta.error?.status;
        const knownHttpError =
          !row.meta.reconciliation &&
          Number.isInteger(status) &&
          status >= 400 &&
          status <= 599;
        if (
          Number(row.cost_usd) !== 0 ||
          !(row.meta.reconciliation === 'not_charged' || knownHttpError)
        )
          throw unavailable();
        continue;
      }
      const key = row.idempotency_key.split(':');
      const index = Number(key[2]);
      const pageIndex = Number(row.payload?.page ?? key[3]);
      const pair = pairs[index];
      if (
        key[0] !== 'google.request' ||
        key[1] !== batch.id ||
        !pair ||
        !Number.isInteger(pageIndex) ||
        pageIndex < 0 ||
        pageIndex !== Number(key[3])
      )
        throw unavailable();
      const stateKey = pairKey(pair.query, pair.city, pair.language);
      // The page index is global for this pair, even across batches and retries.
      // Never replace a newer page/token with a lower-index receipt.
      if ((progress[stateKey]?.pages ?? 0) > pageIndex + 1) continue;
      const page = googlePageSchema.parse(JSON.parse(row.meta.response.text));
      let end = -1;
      page.places.forEach((place, i) => {
        if (ids.has(place.id)) end = i;
      });
      progress[stateKey] = {
        pages: pageIndex + 1,
        token: page.nextPageToken,
        exhausted: !page.nextPageToken || pageIndex >= 2,
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
      campaign.status === 'archived' ||
      campaign.status === 'paused'
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
    if (
      !campaign.product_id ||
      !(
        await client.query('select id from products where id=$1', [
          campaign.product_id,
        ])
      ).rows[0]
    )
      throw new CampaignProductRequired();
    const progress = await campaignProgress(client, campaignId);
    if (
      resultsExhausted(
        campaign.queries,
        campaign.cities,
        progress,
        normalizeCampaignLanguages(campaign).language_codes,
      )
    ) {
      await client.query('commit');
      return { exhausted: true };
    }
    const { rows: settings } = await client.query(
      "select key,value from settings where key in ('google.field_profiles','retention.google_days')",
    );
    const config = Object.fromEntries(settings.map((r) => [r.key, r.value]));
    const profile = profilesSchema
      .parse(config['google.field_profiles'])
      .find((p) => p.id === 'contacts');
    if (!profile) throw Error('Profile missing');
    if (!fixture)
      await checkGooglePlanBudget(
        client,
        campaignId,
        plannedGoogleRequests(campaign, progress) * profile.priceUsd,
      );
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
