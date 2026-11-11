import type { PoolClient } from 'pg';
import {
  profilesSchema,
  type CampaignInput,
  type GoogleProfile,
} from '@sonar/core';
import { sonarPool } from './index.js';
import { enqueueTask, logActivity } from './tasks.js';
export type BatchConfig = CampaignInput & {
  profile: GoogleProfile;
  retentionDays: number;
};
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
