import { randomUUID } from 'node:crypto';
import type { RegistryEntity, RegistryEntityType } from '@sonar/core';
import { sonarPool } from '@sonar/db';
import { enqueueTask, logActivity } from '@sonar/db/tasks';

export type RegistryCandidate = { type: RegistryEntityType; id: string };
export function validRegistryCandidate(
  value: unknown,
): value is RegistryCandidate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as RegistryCandidate;
  return (
    ['UO', 'FOP', 'FSU'].includes(candidate.type) &&
    typeof candidate.id === 'string' &&
    /^[1-9]\d*$/.test(candidate.id)
  );
}

export async function registryAction(
  userId: string,
  decision?: {
    companyId: string;
    candidate: RegistryCandidate;
    action: 'confirm' | 'reject';
  },
) {
  const client = await sonarPool.connect();
  try {
    await client.query('begin');
    if (decision) {
      const { companyId, candidate, action } = decision;
      const company = await client.query(
        'select id from companies where id=$1 for update',
        [companyId],
      );
      if (!company.rowCount) return await finish(null);
      const { rows } = await client.query<{
        id: string;
        value: RegistryEntity[];
      }>(
        "select id,value from company_facts where company_id=$1 and kind='registry_candidates' and source='registry' for update",
        [companyId],
      );
      const matches = (entity: RegistryEntity) =>
        entity.entity_type === candidate.type && entity.id === candidate.id;
      if (
        !rows.some(
          (fact) => Array.isArray(fact.value) && fact.value.some(matches),
        )
      )
        return await finish(null);
      if (action === 'reject') {
        for (const fact of rows) {
          if (!Array.isArray(fact.value)) continue;
          const remaining = fact.value.filter((entity) => !matches(entity));
          if (remaining.length)
            await client.query(
              'update company_facts set value=$2 where id=$1',
              [fact.id, JSON.stringify(remaining)],
            );
          else
            await client.query('delete from company_facts where id=$1', [
              fact.id,
            ]);
        }
        await client.query(
          "insert into company_facts(company_id,kind,value,source) values($1,'registry_rejected',$2,'manual') on conflict do nothing",
          [companyId, JSON.stringify(candidate)],
        );
        await logActivity(
          'registry.candidate.rejected',
          'company',
          companyId,
          userId,
          { candidate },
          client,
        );
        return await finish({ rejected: true });
      }
      const { rows: active } = await client.query(
        "select id,status from tasks where type='registry.match' and payload->>'companyId'=$1 and payload->'candidate'->>'type'=$2 and payload->'candidate'->>'id'=$3 and status in ('queued','running') order by created_at desc limit 1",
        [companyId, candidate.type, candidate.id],
      );
      if (active[0]) return await finish(active[0]);
      const id = await enqueueTask(
        'registry.match',
        `registry.confirm:${companyId}:${randomUUID()}`,
        { companyId, candidate, actorId: userId },
        client,
      );
      await client.query(
        "update tasks set subject_type='company',subject_id=$2 where id=$1",
        [id, companyId],
      );
      await logActivity(
        'registry.candidate.queued',
        'company',
        companyId,
        userId,
        { candidate, taskId: id },
        client,
      );
      return await finish({ id, status: 'queued' });
    }
    await client.query(
      "select pg_advisory_xact_lock(hashtext('registry.phones.sync'))",
    );
    const { rows: active } = await client.query(
      "select id,status from tasks where type='registry.phones.sync' and status in ('queued','running','paused') order by created_at desc limit 1",
    );
    if (active[0]) return await finish(active[0]);
    const id = await enqueueTask(
      'registry.phones.sync',
      `registry.phones.sync:${randomUUID()}`,
      {},
      client,
    );
    await logActivity(
      'registry.phones.sync.queued',
      'settings',
      null,
      userId,
      { taskId: id },
      client,
    );
    return await finish({ id, status: 'queued' });

    async function finish<T>(value: T) {
      await client.query('commit');
      return value;
    }
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
