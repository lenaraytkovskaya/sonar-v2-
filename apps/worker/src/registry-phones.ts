import { normalizePhone, registryTables } from '@sonar/core';
import { registryPool, sonarPool } from '@sonar/db';
import { boss, runTask, TaskFailure, type TaskOutcome } from '@sonar/db/tasks';

type SourceContact = {
  id: string;
  kind: string;
  value: string;
  normalized_value: string;
  entity_type: string;
  entity_id: string;
  confidence: string;
};
type Progress = {
  cursor: string;
  scanned: number;
  indexed: number;
  estimatedTotal: string | null;
  status: 'running' | 'done';
  updatedAt: string | null;
};
const progressKey = 'registry.phones.progress';

export async function runRegistryPhoneSync(): Promise<TaskOutcome> {
  const local = await sonarPool.connect();
  let locked = false;
  let destroy = false;
  try {
    const {
      rows: [lock],
    } = await local.query(
      "select pg_try_advisory_lock(hashtextextended('registry.phones.sync',0)) as locked",
    );
    locked = lock.locked;
    if (!locked)
      return {
        status: 'skipped',
        reasonCode: 'registry_sync_running',
        reasonUk: 'Синхронізація телефонів ЄДР уже виконується.',
      };
    const { rows: settings } = await local.query(
      "select key,value from settings where key like 'registry.phones.%'",
    );
    const config = Object.fromEntries(
      settings.map((row) => [row.key, row.value]),
    );
    const batchSize = Number(config['registry.phones.batch_size']);
    const timeout = Number(config['registry.phones.statement_timeout_ms']);
    let progress: Progress = config[progressKey];
    if (
      !Number.isInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > 50000 ||
      !Number.isInteger(timeout) ||
      timeout < 1 ||
      !progress ||
      !/^\d+$/.test(progress.cursor)
    )
      throw new Error('Invalid registry phone sync settings');
    const source = await registryPool.connect();
    try {
      let estimate: string | null = null;
      for (;;) {
        let rows: SourceContact[];
        try {
          await source.query('begin read only');
          await source.query("select set_config('statement_timeout',$1,true)", [
            String(timeout),
          ]);
          if (estimate === null) {
            const {
              rows: [volume],
            } = await source.query(
              "select case when reltuples<0 then null else reltuples::bigint::text end as count from pg_class where oid='public.edr_contacts'::regclass",
            );
            estimate = volume?.count ?? null;
          }
          // Read all kinds so the primary-key scan stays bounded even for sparse phones.
          ({ rows } = await source.query<SourceContact>(
            'select id::text,kind,value,normalized_value,entity_type,entity_id::text,confidence::text from public.edr_contacts c where c.id>$1::bigint order by c.id limit $2',
            [progress.cursor, batchSize],
          ));
          await source.query('commit');
        } catch (error) {
          await source.query('rollback').catch(() => undefined);
          throw error;
        }
        const phones = rows.flatMap((row) => {
          if (
            !/phone|tel|тел/i.test(row.kind) ||
            !Object.hasOwn(registryTables, row.entity_type)
          )
            return [];
          const phone =
            normalizePhone(row.normalized_value || row.value, 'UA') ||
            normalizePhone(row.value, 'UA');
          return phone
            ? [
                {
                  phone_e164: phone,
                  entity_type: row.entity_type,
                  entity_id: row.entity_id,
                  confidence: row.confidence,
                },
              ]
            : [];
        });
        await local.query('begin');
        try {
          // One JSON parameter avoids PostgreSQL's parameter limit for 50,000 contacts.
          const {
            rows: [added],
          } = await local.query(
            `with saved as (
              insert into registry_phones(phone_e164,entity_type,entity_id,confidence)
              select phone_e164,entity_type,entity_id,max(confidence)
              from jsonb_to_recordset($1::jsonb) as p(phone_e164 text,entity_type text,entity_id bigint,confidence numeric)
              group by phone_e164,entity_type,entity_id
              on conflict(phone_e164,entity_type,entity_id) do update
                set confidence=greatest(registry_phones.confidence,excluded.confidence)
              returning xmax=0 as inserted
            ) select count(*) filter(where inserted)::integer as count from saved`,
            [JSON.stringify(phones)],
          );
          progress = {
            cursor: rows.at(-1)?.id ?? progress.cursor,
            scanned: progress.scanned + rows.length,
            indexed: progress.indexed + Number(added.count),
            estimatedTotal: estimate,
            status: rows.length < batchSize ? 'done' : 'running',
            updatedAt: new Date().toISOString(),
          };
          await local.query(
            'update settings set value=$2::jsonb,updated_at=now() where key=$1',
            [progressKey, JSON.stringify(progress)],
          );
          await local.query('commit');
        } catch (error) {
          await local.query('rollback').catch(() => undefined);
          throw error;
        }
        if (progress.status === 'done')
          return { status: 'done', result: progress };
      }
    } finally {
      source.release();
    }
  } catch {
    throw new TaskFailure(
      'registry_phone_sync_failed',
      'Не вдалося синхронізувати телефони ЄДР. Прогрес збережено; перевірте підключення та повторіть.',
    );
  } finally {
    if (locked) {
      try {
        await local.query(
          "select pg_advisory_unlock(hashtextextended('registry.phones.sync',0))",
        );
      } catch {
        destroy = true;
      }
    }
    local.release(destroy);
  }
}

export async function registerRegistryPhoneTasks() {
  await boss.createQueue('registry.phones.sync');
  await runTask('registry.phones.sync', runRegistryPhoneSync);
}
