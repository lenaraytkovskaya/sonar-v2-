import { enqueueCampaignScores } from './scoring.js';
import { campaignSchema, type CampaignInput } from '@sonar/core';
import { sonarPool } from './index.js';
import { logActivity } from './tasks.js';
export async function saveCampaign(
  input: CampaignInput,
  id: string | null,
  userId: string,
  source = 'form',
) {
  const data = campaignSchema.parse(input);
  const client = await sonarPool.connect();
  try {
    await client.query('begin');
    const previous = id
      ? (
          await client.query(
            'select scoring_weights from campaigns where id=$1 for update',
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
      data.offer,
      data.batch_size,
      data.budget_usd,
      data.channels,
      data.send_mode,
      data.scoring_weights,
      data.status,
      data.field_profile,
    ];
    const { rows } = id
      ? await client.query(
          `update campaigns set name=$1,country_code=$2,language_code=$3,cities=$4,queries=$5,offer=$6,batch_size=$7,budget_usd=$8,channels=$9,send_mode=$10,scoring_revision=scoring_revision+case when scoring_weights<>$11::jsonb then 1 else 0 end,scoring_weights=$11,status=$12,field_profile=$13,updated_at=now() where id=$14 returning *`,
          [...values, id],
        )
      : await client.query(
          `insert into campaigns(name,country_code,language_code,cities,queries,offer,batch_size,budget_usd,channels,send_mode,scoring_weights,status,field_profile,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
          [...values, userId],
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
      JSON.stringify(Object.entries(previous.scoring_weights).sort()) !==
        JSON.stringify(Object.entries(data.scoring_weights).sort())
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
