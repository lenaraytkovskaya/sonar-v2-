import {
  campaignInactiveReasonCode,
  campaignPausedReasonCode,
  campaignPauseScopes,
  campaignPauseTypes,
} from '@sonar/core';
import type { PoolClient } from 'pg';
import { sonarPool } from './index.js';
import { dispatch, logActivity, transaction } from './tasks.js';

type Db = Pick<PoolClient, 'query'>;
type TaskRef = { type: string; payload: Record<string, unknown> };

const list = (types: string[]) => types.map((type) => `'${type}'`).join(',');
// Tasks of one campaign, whichever way the task names it. $1 is the campaign id.
const inCampaign = `(
  (t.type in (${list(campaignPauseTypes('campaign'))}) and t.payload->>'campaignId'=$1::text)
  or (t.type in (${list(campaignPauseTypes('message'))}) and exists(select 1 from messages m join conversations v on v.id=m.conversation_id where m.id::text=t.payload->>'messageId' and v.campaign_id=$1))
  or (t.type in (${list(campaignPauseTypes('batch'))}) and exists(select 1 from batches b where b.id::text=t.payload->>'batchId' and b.campaign_id=$1))
  or (t.type in (${list(campaignPauseTypes('company'))}) and exists(select 1 from campaign_companies cc where cc.company_id::text=t.payload->>'companyId' and cc.campaign_id=$1))
)`;

async function campaignIdsOfTask(db: Db, task: TaskRef): Promise<string[]> {
  const rule = campaignPauseScopes[task.type];
  const id = (key: string) =>
    typeof task.payload[key] === 'string' ? (task.payload[key] as string) : '';
  if (!rule) return [];
  if (rule.scope === 'campaign')
    return id('campaignId') ? [id('campaignId')] : [];
  const sql = {
    message:
      'select v.campaign_id as id from messages m join conversations v on v.id=m.conversation_id where m.id::text=$1',
    batch: 'select campaign_id as id from batches where id::text=$1',
    company:
      'select distinct campaign_id as id from campaign_companies where company_id::text=$1',
  }[rule.scope];
  const key =
    rule.scope === 'message'
      ? 'messageId'
      : rule.scope === 'batch'
        ? 'batchId'
        : 'companyId';
  if (!id(key)) return [];
  const { rows } = await db.query(sql, [id(key)]);
  return rows.map((row) => String(row.id)).filter(Boolean);
}

// A company in several campaigns keeps working while at least one of them is not paused.
export async function taskBlockedByPause(db: Db, task: TaskRef) {
  if (!campaignPauseScopes[task.type]?.guard) return false;
  const ids = await campaignIdsOfTask(db, task);
  if (!ids.length) return false;
  const { rows } = await db.query(
    'select status from campaigns where id=any($1::uuid[])',
    [ids],
  );
  return rows.length > 0 && rows.every((row) => row.status === 'paused');
}

export async function pauseCampaign(campaignId: string, userId: string) {
  const { rowCount } = await sonarPool.query(
    "update campaigns set status='paused',updated_at=now() where id=$1 and status='active'",
    [campaignId],
  );
  if (rowCount)
    await logActivity('campaign.pause', 'campaign', campaignId, userId, {});
  return { paused: !!rowCount };
}

// Resume does not create a batch: it puts the tasks held by the pause back into the queue.
// The status update is the gate, so a second call finds nothing to queue.
export async function resumeCampaign(campaignId: string, userId: string) {
  return transaction(async (client) => {
    const { rowCount } = await client.query(
      "update campaigns set status='active',updated_at=now() where id=$1 and status='paused'",
      [campaignId],
    );
    if (!rowCount) return { resumed: false, requeued: 0 };
    const { rows } = await client.query(
      `update tasks t set status='queued',reason_code=null,reason_uk=null,finished_at=null
       where t.status='paused' and t.reason_code in ('${campaignPausedReasonCode}','${campaignInactiveReasonCode}') and ${inCampaign}
       returning t.id,t.type`,
      [campaignId],
    );
    for (const row of rows) await dispatch(client, row.id, row.type);
    await logActivity(
      'campaign.resume',
      'campaign',
      campaignId,
      userId,
      { requeued: rows.length },
      client,
    );
    return { resumed: true, requeued: rows.length };
  });
}

export async function campaignRunState(campaignId: string) {
  const [{ rows: campaign }, { rows: counts }, { rows: spent }] =
    await Promise.all([
      sonarPool.query('select status,budget_usd from campaigns where id=$1', [
        campaignId,
      ]),
      sonarPool.query(
        `select count(*) filter (where t.status in ('queued','running'))::int as active,
         count(*) filter (where t.status='paused' and t.reason_code in ('${campaignPausedReasonCode}','${campaignInactiveReasonCode}'))::int as held
       from tasks t where ${inCampaign}`,
        [campaignId],
      ),
      sonarPool.query(
        `select coalesce(sum(s.cost_usd),0) as spent from spend_events s join tasks t on t.id=s.task_id
         left join batches b on b.id=t.batch_id left join messages m on m.id=(t.payload->>'messageId')::uuid
         left join conversations v on v.id=coalesce(m.conversation_id,(t.payload->>'conversationId')::uuid)
         where coalesce(b.campaign_id,(t.payload->>'campaignId')::uuid,v.campaign_id)=$1`,
        [campaignId],
      ),
    ]);
  if (!campaign[0]) return null;
  return {
    status: campaign[0].status as string,
    budget: Number(campaign[0].budget_usd),
    spent: Number(spent[0].spent),
    ...counts[0],
  } as {
    status: string;
    budget: number;
    spent: number;
    active: number;
    held: number;
  };
}
