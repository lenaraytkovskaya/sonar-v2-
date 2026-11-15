import {
  ManualSourceError,
  normalizeManualSource,
  type ManualSourceInput,
} from '@sonar/core';
import { sonarPool } from './index.js';
import { transaction } from './email.js';
import {
  enqueueSiteScan,
  enqueueTask,
  logActivity,
  recordManualCompanyCode,
  retryTask,
} from './tasks.js';
import { enqueueCompanySocial, type SocialRetryIntent } from './social.js';

export type ManualSourceResult = {
  source: ManualSourceInput['source'];
  target: string;
  previous: string | null;
  requestId: string;
  taskIds: string[];
  foundAt: Date;
  tasks: {
    id: string;
    status: string;
    reason_uk: string | null;
    result: Record<string, unknown> | null;
  }[];
};
export async function getManualSource(
  companyId: string,
  source: string,
  requestId?: string,
): Promise<ManualSourceResult | null> {
  const {
    rows: [fact],
  } = await sonarPool.query(
    `select value,found_at from company_facts where company_id=$1 and kind='manual_source' and source='manual' and value->>'source'=$2 and ($3::text is null or value->>'requestId'=$3) order by found_at desc,id desc limit 1`,
    [companyId, source, requestId ?? null],
  );
  if (!fact) return null;
  const { rows: tasks } = await sonarPool.query(
    `with recursive attempts as (
      select t.*,array[t.id] as path from tasks t where id=any($1::uuid[])
      union all select t.*,a.path||t.id from attempts a join tasks t on t.id::text=a.result->>'retryTaskId' where not t.id=any(a.path)
    ) select id,status,reason_uk,result from attempts a where not exists(select 1 from tasks t where t.id::text=a.result->>'retryTaskId') order by created_at`,
    [fact.value.taskIds],
  );
  return { ...fact.value, foundAt: fact.found_at, tasks };
}

export async function saveManualSource(
  companyId: string,
  input: ManualSourceInput,
  userId: string,
) {
  const data = normalizeManualSource(input);
  const retries = await transaction<SocialRetryIntent[]>(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `manual.source:${companyId}`,
    ]);
    // Match the scanner/Prozorro lock order before taking the company row lock.
    const lockKey =
      data.source === 'registry'
        ? `prozorro.company:${companyId}`
        : data.source === 'website'
          ? `site.scan:${companyId}`
          : `manual.${data.source}:${companyId}`;
    const {
      rows: [lock],
    } = await client.query(
      'select pg_try_advisory_xact_lock(hashtextextended($1,0)) as locked',
      [lockKey],
    );
    if (!lock.locked) throw new ManualSourceError('sourceBusy');
    const {
      rows: [company],
    } = await client.query(
      'select * from companies where id=$1 for no key update',
      [companyId],
    );
    if (!company) throw new ManualSourceError('companyNotFound');
    const {
      rows: [prior],
    } = await client.query(
      "select value from company_facts where company_id=$1 and kind='manual_source' and value->>'requestId'=$2",
      [companyId, data.requestId],
    );
    if (prior) {
      if (
        prior.value.source !== data.source ||
        prior.value.target !== data.value
      )
        throw new ManualSourceError('staleSource');
      return prior.value.socialRetries ?? [];
    }
    let taskIds: string[] = [];
    let socialRetries: SocialRetryIntent[] = [];
    let previous: string | null = null;
    const key = `manual.source:${companyId}:${data.requestId}`;
    if (data.source === 'website' || data.source === 'googleMaps') {
      const field = data.source === 'website' ? 'website' : 'google_maps_uri';
      previous = company[field];
      if (data.expected !== previous)
        throw new ManualSourceError('staleSource');
      // Never attach a different request to an in-flight scan of another target.
      const { rows: active } = await client.query(
        "select id,payload from tasks where type=$2 and subject_id=$1 and status in ('queued','running','paused') order by created_at desc",
        [companyId, data.source === 'website' ? 'site.scan' : 'google.company'],
      );
      if (
        active.some(
          (t) =>
            (data.source === 'website'
              ? (t.payload.website ?? previous)
              : t.payload.sourceUrl) !== data.value,
        )
      )
        throw new ManualSourceError('sourceBusy');
      if (data.source === 'website') {
        await client.query(
          'update companies set website=$2,domain=$3,updated_at=now() where id=$1',
          [companyId, data.value, 'domain' in data ? data.domain : null],
        );
        const task =
          active[0] ?? (await enqueueSiteScan(companyId, userId, client, key));
        taskIds = [task!.id];
      } else {
        const {
          rows: [campaign],
        } = await client.query(
          'select campaign_id from campaign_companies where company_id=$1 order by added_at desc limit 1',
          [companyId],
        );
        if (!campaign) throw new ManualSourceError('campaignRequired');
        await client.query(
          'update companies set google_maps_uri=$2,updated_at=now() where id=$1',
          [companyId, data.value],
        );
        const id =
          active[0]?.id ??
          (await enqueueTask(
            'google.company',
            key,
            {
              companyId,
              campaignId: campaign.campaign_id,
              sourceUrl: data.value,
              placeId: 'placeId' in data ? data.placeId : null,
            },
            client,
          ));
        taskIds = [id];
      }
    } else if (data.source === 'registry') {
      if (company.country_code !== 'UA')
        throw new ManualSourceError('registryCountry');
      await recordManualCompanyCode(client, companyId, data.value, userId);
      const { rows: active } = await client.query(
        "select id,payload from tasks where type='registry.match' and subject_id=$1 and status in ('queued','running')",
        [companyId],
      );
      if (active.some((t) => t.payload.manualCode !== data.value))
        throw new ManualSourceError('sourceBusy');
      const id =
        active[0]?.id ??
        (await enqueueTask(
          'registry.match',
          key,
          { companyId, manualCode: data.value, actorId: userId },
          client,
        ));
      taskIds = [id];
    } else if ('target' in data && data.target) {
      await client.query(
        `insert into contacts(company_id,kind,value,normalized,source,source_url,rank,meta) values($1,'social',$2,$2,'manual',$2,100,$3) on conflict(company_id,kind,normalized) do nothing`,
        [companyId, data.value, { created_by: userId }],
      );
      const queued = await enqueueCompanySocial(
        companyId,
        userId,
        client,
        data.target,
      );
      taskIds = queued.tasks.map((t) => t.id);
      socialRetries = queued.retryTasks ?? [];
    }
    if (!taskIds.length)
      throw new Error('Manual source did not produce a task');
    if (data.source !== 'social')
      await client.query(
        "update tasks set subject_type='company',subject_id=$2 where id=any($1::uuid[])",
        [taskIds, companyId],
      );
    const value = {
      source: data.source,
      target: data.value,
      previous,
      requestId: data.requestId,
      taskIds,
      ...(socialRetries.length ? { socialRetries } : {}),
    };
    await client.query(
      "insert into company_facts(company_id,kind,value,source,source_url) values($1,'manual_source',$2,'manual',$3)",
      [
        companyId,
        JSON.stringify(value),
        data.source === 'registry' ? `/companies/${companyId}` : data.value,
      ],
    );
    await logActivity(
      'company.source.manual',
      'company',
      companyId,
      userId,
      value,
      client,
    );
    return socialRetries;
  });
  // The persisted intent also survives a crash/dispatch failure after commit.
  // A version fence makes replays and concurrent companies share one retry.
  for (const retry of retries)
    await retryTask(retry.id, userId, retry.requestVersion);
  return getManualSource(companyId, data.source, data.requestId);
}
