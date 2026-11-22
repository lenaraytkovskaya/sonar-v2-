import { enqueueCampaignScores } from './scoring.js';
import {
  campaignSchema,
  normalizeCampaignLanguages,
  type CampaignInput,
} from '@sonar/core';
import { sonarPool } from './index.js';
import { logActivity } from './tasks.js';
export async function saveCampaign(
  input: Omit<CampaignInput, 'offer' | 'outreach_goal' | 'min_score'> &
    Partial<Pick<CampaignInput, 'offer' | 'outreach_goal' | 'min_score'>>,
  id: string | null,
  userId: string,
  source = 'form',
) {
  const data = normalizeCampaignLanguages(campaignSchema.parse(input));
  const client = await sonarPool.connect();
  try {
    await client.query('begin');
    const previous = id
      ? (
          await client.query(
            'select scoring_weights,min_score,product_id from campaigns where id=$1 for update',
            [id],
          )
        ).rows[0]
      : null;
    const values = [
      data.name,
      data.country_code,
      data.language_code,
      data.cities,
      data.queries,
      data.batch_size,
      data.budget_usd,
      data.channels,
      data.send_mode,
      data.scoring_weights,
      data.field_profile,
      data.min_score,
      data.language_codes,
      data.product_id === undefined
        ? (previous?.product_id ?? null)
        : data.product_id,
    ];
    // Legacy offer/goals are immutable here; parsed defaults must never erase emergency fallback data.
    // Status changes only through start/pause/resume, so stale forms cannot undo a pause.
    const { rows } = id
      ? await client.query(
          `update campaigns set name=$1,country_code=$2,language_code=$3,cities=$4,queries=$5,batch_size=$6,budget_usd=$7,channels=$8,send_mode=$9,scoring_revision=scoring_revision+case when scoring_weights<>$10::jsonb then 1 else 0 end,scoring_weights=$10,field_profile=$11,min_score=$12,language_codes=$13,product_id=$14,updated_at=now() where id=$15 returning *`,
          [...values, id],
        )
      : await client.query(
          `insert into campaigns(name,country_code,language_code,cities,queries,batch_size,budget_usd,channels,send_mode,scoring_weights,field_profile,min_score,language_codes,product_id,status,created_by,offer) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'') returning *`,
          [...values, data.status, userId],
        );
    if (!rows[0]) throw Error('Campaign missing');
    await logActivity(
      id ? 'campaign.update' : 'campaign.create',
      'campaign',
      rows[0].id,
      userId,
      { source, status: data.status },
      client,
    );
    if (
      previous &&
      (Number(previous.min_score) !== data.min_score ||
        JSON.stringify(Object.entries(previous.scoring_weights).sort()) !==
          JSON.stringify(Object.entries(data.scoring_weights).sort()))
    )
      await enqueueCampaignScores(rows[0].id, userId, client);
    await client.query('commit');
    return rows[0];
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
