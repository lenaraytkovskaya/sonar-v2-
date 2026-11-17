import type { PoolClient } from 'pg';
import {
  normalizeWebsite,
  socialTarget,
  type SocialTarget,
  type SocialProfile,
  type SocialNetwork,
} from '@sonar/core';
import { sonarPool } from './index.js';
import { enqueueTask, logActivity, retryTask } from './tasks.js';
export type SocialPayload = {
  companyId: string;
  companyIds?: string[];
  target: SocialTarget;
  requestVersion?: number;
  manual?: boolean;
  anonymous?: boolean;
};
type SocialTask = {
  id: string;
  status: string;
  reasonUk: string | null;
  reasonCode: string | null;
};
export type SocialRetryIntent = { id: string; requestVersion: number };
async function targets(
  client: Pick<PoolClient, 'query'>,
  companyId: string,
): Promise<SocialTarget[]> {
  const { rows } = await client.query(
    `select website as value from companies where id=$1 union select value from contacts where company_id=$1 and kind='social'`,
    [companyId],
  );
  return [
    ...new Map(
      rows.flatMap(({ value }) => {
        const target = value && socialTarget(value);
        return target && target.kind !== 'unsupported'
          ? [[`${target.network}:${target.handle}`, target] as const]
          : [];
      }),
    ).values(),
  ];
}
export async function prepareSocialRetry(
  client: PoolClient,
  original: { id: string; payload: SocialPayload },
) {
  const { rows } = await client.query(
    `select 1 from tasks where type='social.request' and payload->>'parentId'=$1 and result->>'billingPending'='true' limit 1`,
    [original.id],
  );
  if (rows.length) return false;
  await client.query(
    `update tasks set payload=payload||$2::jsonb,result=null where id=$1`,
    [
      original.id,
      JSON.stringify({
        requestVersion: (original.payload.requestVersion ?? 0) + 1,
        manual: true,
      }),
    ],
  );
  return true;
}
export async function enqueueCompanySocial(
  companyId: string,
  userId: string | null,
  existing?: PoolClient,
  onlyTarget?: SocialTarget,
): Promise<{
  tasks: { id: string; status: string; created: boolean }[];
  disabled: boolean;
  retryTasks?: SocialRetryIntent[];
}> {
  const client = existing ?? (await sonarPool.connect());
  try {
    if (!existing) await client.query('begin');
    const {
      rows: [enabled],
    } = await client.query(
      "select value from settings where key='social.enabled'",
    );
    if (!userId && enabled?.value !== true) {
      if (!existing) await client.query('commit');
      return { tasks: [], disabled: true };
    }
    const tasks: { id: string; status: string; created: boolean }[] = [];
    const retryTasks: SocialRetryIntent[] = [];
    for (const target of onlyTarget
      ? [onlyTarget]
      : await targets(client, companyId)) {
      if (!userId && !['instagram', 'facebook'].includes(target.network))
        continue;
      const key = `social.fetch:${target.network}:${target.handle}:${new Date().toISOString().slice(0, 10)}`;
      await client.query(
        'select pg_advisory_xact_lock(hashtextextended($1,0))',
        [key],
      );
      const {
        rows: [prior],
      } = await client.query(
        'select * from tasks where idempotency_key=$1 for update',
        [key],
      );
      if (prior) {
        await client.query(
          `update tasks set payload=jsonb_set(payload,'{companyIds}',$2::jsonb) where id=$1`,
          [
            prior.id,
            JSON.stringify([
              ...new Set([
                prior.payload.companyId,
                ...(prior.payload.companyIds ?? []),
                companyId,
              ]),
            ]),
          ],
        );
        if (prior.status === 'done' && prior.result?.profile)
          await saveSocialProfile(
            client,
            [companyId],
            target,
            prior.result.profile,
            new Date(prior.finished_at),
          );
        if (userId && ['failed', 'paused', 'skipped'].includes(prior.status))
          retryTasks.push({
            id: prior.id,
            requestVersion: prior.payload.requestVersion ?? 0,
          });
        tasks.push({ id: prior.id, status: prior.status, created: false });
      } else {
        const id = await enqueueTask(
          'social.fetch',
          key,
          {
            companyId,
            companyIds: [companyId],
            target,
            requestVersion: 0,
            manual: !!userId,
            anonymous: !userId,
          },
          client,
        );
        if (id) {
          await client.query(
            "update tasks set subject_type='company',subject_id=$2 where id=$1",
            [id, companyId],
          );
          await logActivity(
            'social.fetch.queued',
            'company',
            companyId,
            userId,
            { taskId: id, network: target.network },
            client,
          );
          tasks.push({ id, status: 'queued', created: true });
        }
      }
    }
    if (!existing) await client.query('commit');
    if (userId && !existing)
      for (const retry of retryTasks)
        if (await retryTask(retry.id, userId, retry.requestVersion))
          tasks.find((task) => task.id === retry.id)!.status = 'queued';
    // A caller-owned transaction must commit source/target changes before retrying.
    return { tasks, disabled: false, ...(existing ? { retryTasks } : {}) };
  } catch (error) {
    if (!existing) await client.query('rollback');
    throw error;
  } finally {
    if (!existing) client.release();
  }
}
export async function saveSocialProfile(
  client: Pick<PoolClient, 'query'>,
  companyIds: string[],
  target: SocialTarget,
  profile: SocialProfile,
  foundAt = new Date(),
) {
  for (const companyId of companyIds) {
    await client.query(
      `delete from company_facts where company_id=$1 and kind='social_profile' and source=$2 and source_url=$3`,
      [companyId, target.network, target.canonicalUrl],
    );
    await client.query(
      `insert into company_facts(company_id,kind,value,source,source_url,found_at) values($1,'social_profile',$2,$3,$4,$5)`,
      [
        companyId,
        JSON.stringify({ target, profile }),
        target.network,
        target.canonicalUrl,
        foundAt,
      ],
    );
    for (const [kind, values] of [
      ['phone', profile.phones],
      ['email', profile.emails],
      ['address', profile.address ? [profile.address] : []],
      ['website', profile.website ? [profile.website] : []],
    ] as const)
      for (const value of values) {
        const normalized =
          kind === 'website'
            ? (normalizeWebsite(value)?.domain ?? value)
            : value;
        await client.query(
          `insert into contacts(company_id,kind,value,normalized,source,source_url,found_at) values($1,$2,$3,$4,$5,$6,$7) on conflict(company_id,kind,normalized) do update set found_at=case when contacts.source=excluded.source then excluded.found_at else contacts.found_at end,source_url=case when contacts.source=excluded.source then excluded.source_url else contacts.source_url end,meta=contacts.meta||jsonb_build_object('alsoOnSocial',jsonb_build_object('url',excluded.source_url,'foundAt',excluded.found_at))`,
          [
            companyId,
            kind,
            value,
            normalized,
            target.network,
            target.canonicalUrl,
            foundAt,
          ],
        );
      }
  }
}
export async function getCompanySocial(companyId: string): Promise<{
  profiles: Array<{
    network: SocialNetwork;
    target: SocialTarget;
    profile: SocialProfile | null;
    sourceUrl: string;
    foundAt: Date | null;
    task: SocialTask | null;
  }>;
}> {
  const known = await targets(sonarPool, companyId);
  const { rows: facts } = await sonarPool.query(
    `select value,source_url,found_at from company_facts where company_id=$1 and kind='social_profile' order by found_at desc`,
    [companyId],
  );
  const { rows: tasks } = await sonarPool.query(
    `select id,status,reason_uk,reason_code,payload from tasks where type='social.fetch' and (payload->>'companyId'=$1 or payload->'companyIds' ? $1) order by created_at desc`,
    [companyId],
  );
  for (const fact of facts)
    if (fact.value.target) known.push(fact.value.target);
  return {
    profiles: [
      ...new Map(
        known.map((target) => [`${target.network}:${target.handle}`, target]),
      ).values(),
    ].map((target) => {
      const fact = facts.find((f) => f.source_url === target.canonicalUrl);
      const row = tasks.find(
        (t) =>
          t.payload.target?.network === target.network &&
          t.payload.target?.handle === target.handle,
      );
      const task: SocialTask | null = row
        ? {
            id: row.id,
            status: row.status,
            reasonUk: row.reason_uk,
            reasonCode: row.reason_code,
          }
        : null;
      return {
        network: target.network,
        target,
        profile: (fact?.value.profile ?? null) as SocialProfile | null,
        sourceUrl: target.canonicalUrl,
        foundAt: fact?.found_at ?? null,
        task,
      };
    }),
  };
}
