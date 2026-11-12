import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { RegistryEntity } from '@sonar/core';

vi.mock('@sonar/db', () => import('./index.js'));
vi.mock('@sonar/db/tasks', () => import('./tasks.js'));
const enabled = process.env.RUN_DB_TESTS === '1';
let db: typeof import('./index.js');
const companyIds = [randomUUID(), randomUUID(), randomUUID()];
const actorId = randomUUID();
const entityIds = ['9007199254740981', '9007199254740982', '9007199254740983'];
const keys = ['registry.phones.progress', 'registry.phones.batch_size'];
let originals: { key: string; value: unknown }[] = [];
const entities = entityIds.map((id, i) => ({
  id,
  entity_type: 'FOP' as const,
  edrpou: null,
  name: i === 2 ? 'Петренко Петро Петрович' : 'Іваненко Іван Іванович',
  normalized_name:
    i === 2 ? 'петренко петро петрович' : 'іваненко іван іванович',
  short_name: null,
  status: 'зареєстровано',
  registration_date: '2025-01-01',
  termination_date: null,
  director: null,
  address: `Київ, Тестова ${i + 1}`,
  published_at: '2026-11-01',
}));
const sourceContacts = [
  {
    id: '1',
    kind: 'telephone',
    value: '0671234567',
    normalized_value: '0671234567',
    entity_type: 'FOP',
    entity_id: entityIds[0],
    confidence: '0.8',
  },
  {
    id: '2',
    kind: 'phone',
    value: '+380671234567',
    normalized_value: '+380671234567',
    entity_type: 'FOP',
    entity_id: entityIds[0],
    confidence: '0.95',
  },
  {
    id: '3',
    kind: 'phone',
    value: '0501234567',
    normalized_value: '0501234567',
    entity_type: 'FOP',
    entity_id: entityIds[1],
    confidence: '0.9',
  },
];
let failSecondBatch = false;
const source = {
  query: vi.fn(async (sql: string, values: unknown[] = []) => {
    if (/\b(insert|update|delete|create|alter|truncate)\b/i.test(sql))
      throw new Error('Registry writes are forbidden in this fixture');
    if (sql.includes('from pg_class')) return { rows: [{ count: '3' }] };
    if (sql.includes('from public.edr_contacts c')) {
      if (failSecondBatch && values[0] === '2') {
        failSecondBatch = false;
        throw new Error('fixture statement timeout');
      }
      return {
        rows: sourceContacts
          .filter((c) => BigInt(c.id) > BigInt(values[0] as string))
          .slice(0, Number(values[1])),
      };
    }
    if (sql.includes('where e.id=$1'))
      return { rows: entities.filter((e) => e.id === values[0]) };
    if (sql.includes('md5(e.normalized_name)')) {
      const names = values[0] as string[];
      expect(names.every((name) => name === name.toLowerCase())).toBe(true);
      return {
        rows: entities.filter((e) => names.includes(e.normalized_name)),
      };
    }
    return { rows: [] };
  }),
  release: vi.fn(),
};
async function set(key: string, value: unknown) {
  await db.sonarPool.query('update settings set value=$2::jsonb where key=$1', [
    key,
    JSON.stringify(value),
  ]);
}
async function facts(companyId: string) {
  return Object.fromEntries(
    (
      await db.sonarPool.query(
        'select kind,value from company_facts where company_id=$1',
        [companyId],
      )
    ).rows.map((r) => [r.kind, r.value]),
  );
}
beforeAll(async () => {
  if (!enabled) return;
  db = await import('./index.js');
  originals = (
    await db.sonarPool.query(
      'select key,value from settings where key=any($1::text[])',
      [keys],
    )
  ).rows;
  vi.spyOn(db.registryPool, 'connect').mockImplementation((() =>
    Promise.resolve(source)) as typeof db.registryPool.connect);
  await db.sonarPool.query(
    "insert into users(id,email,name,password_hash) values($1,$2,'Registry test','fixture')",
    [actorId, `${actorId}@example.test`],
  );
  for (const id of companyIds)
    await db.sonarPool.query(
      "insert into companies(id,place_id,name,country_code) values($1,$2,'Registry integration test','UA')",
      [id, id],
    );
});

it.skipIf(!enabled)(
  'commits phone upserts with cursor progress, resumes a timeout and replays without duplicates',
  async () => {
    const { runRegistryPhoneSync } =
      await import('../../../apps/worker/src/registry-phones.js');
    await set('registry.phones.batch_size', 2);
    await set('registry.phones.progress', {
      cursor: '0',
      scanned: 0,
      indexed: 0,
      estimatedTotal: null,
      status: 'done',
      updatedAt: null,
    });
    failSecondBatch = true;
    await expect(runRegistryPhoneSync()).rejects.toMatchObject({
      code: 'registry_phone_sync_failed',
    });
    let progress = (
      await db.sonarPool.query(
        "select value from settings where key='registry.phones.progress'",
      )
    ).rows[0].value;
    expect(progress).toMatchObject({ cursor: '2', scanned: 2, indexed: 1 });
    expect(
      (
        await db.sonarPool.query(
          'select confidence::text from registry_phones where entity_id=$1',
          [entityIds[0]],
        )
      ).rows,
    ).toEqual([{ confidence: '0.95' }]);
    await expect(runRegistryPhoneSync()).resolves.toMatchObject({
      status: 'done',
      result: { cursor: '3', scanned: 3, indexed: 2 },
    });
    await expect(runRegistryPhoneSync()).resolves.toMatchObject({
      result: { cursor: '3', scanned: 3, indexed: 2 },
    });
    progress = (
      await db.sonarPool.query(
        "select value from settings where key='registry.phones.progress'",
      )
    ).rows[0].value;
    expect(progress.status).toBe('done');
    expect(
      (
        await db.sonarPool.query(
          'select count(*)::integer as count from registry_phones where entity_id=any($1::bigint[])',
          [entityIds],
        )
      ).rows[0].count,
    ).toBe(2);
  },
);

it.skipIf(!enabled)(
  'matches phone and lowercase FOP names, stores multiple candidates, confirms with actor audit and refuses stale confirmation',
  async () => {
    const { runRegistryMatch } =
      await import('../../../apps/worker/src/registry.js');
    const [phoneCompany, reviewCompany, nameCompany] = companyIds;
    await db.sonarPool.query(
      "insert into contacts(company_id,kind,value,normalized,source) values($1,'phone','0671234567','+380671234567','website')",
      [phoneCompany],
    );
    await expect(
      runRegistryMatch({ companyId: phoneCompany! }, randomUUID()),
    ).resolves.toMatchObject({ status: 'done' });
    expect(await facts(phoneCompany!)).toMatchObject({
      registry_entity: { type: 'FOP', id: entityIds[0] },
      registry_match_method: 'phone',
    });
    for (const [companyId, name] of [
      [reviewCompany, 'ІВАНЕНКО Іван Іванович'],
      [nameCompany, 'ПЕТРЕНКО Петро Петрович'],
    ])
      await db.sonarPool.query(
        "insert into company_facts(company_id,kind,value,source) values($1,'fop_name',$2,'website')",
        [companyId, JSON.stringify(name)],
      );
    await expect(
      runRegistryMatch({ companyId: nameCompany! }, randomUUID()),
    ).resolves.toMatchObject({ status: 'done' });
    expect(await facts(nameCompany!)).toMatchObject({
      registry_match_method: 'fop_name',
      registry_entity: { type: 'FOP', id: entityIds[2] },
    });
    await expect(
      runRegistryMatch({ companyId: reviewCompany! }, randomUUID()),
    ).resolves.toMatchObject({
      status: 'skipped',
      reasonCode: 'registry_candidates',
    });
    const before = await facts(reviewCompany!);
    expect(before.registry_candidates).toHaveLength(2);
    expect(before.registry_entity).toBeUndefined();
    const candidate = { type: 'FOP' as const, id: entityIds[1]! };
    await expect(
      runRegistryMatch(
        { companyId: reviewCompany!, candidate, actorId },
        randomUUID(),
      ),
    ).resolves.toMatchObject({ status: 'done' });
    expect(await facts(reviewCompany!)).toMatchObject({
      registry_entity: candidate,
      registry_match_method: 'confirmed',
    });
    const audit = (
      await db.sonarPool.query(
        "select user_id,details from activity_log where action='registry.candidate.confirmed' and entity_id=$1",
        [reviewCompany],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      user_id: actorId,
      details: {
        method: 'confirmed',
        entityType: 'FOP',
        entityId: entityIds[1],
      },
    });
    await expect(
      runRegistryMatch(
        {
          companyId: reviewCompany!,
          candidate: { type: 'FOP', id: entityIds[0]! },
          actorId,
        },
        randomUUID(),
      ),
    ).resolves.toMatchObject({
      status: 'skipped',
      reasonCode: 'registry_candidate_stale',
    });
    expect(await facts(reviewCompany!)).toMatchObject({
      registry_entity: candidate,
      registry_match_method: 'confirmed',
    });
    expect(
      source.query.mock.calls.some(([sql]) => sql === 'begin read only'),
    ).toBe(true);
    expect(
      entities.every(
        (e: RegistryEntity & { normalized_name: string }) =>
          e.normalized_name === e.normalized_name.toLowerCase(),
      ),
    ).toBe(true);
  },
);

afterAll(async () => {
  if (!enabled || !db) return;
  vi.restoreAllMocks();
  await db.sonarPool.query(
    'delete from activity_log where entity_id=any($1::text[])',
    [companyIds],
  );
  await db.sonarPool.query(
    'delete from company_facts where company_id=any($1::uuid[])',
    [companyIds],
  );
  await db.sonarPool.query(
    'delete from contacts where company_id=any($1::uuid[])',
    [companyIds],
  );
  await db.sonarPool.query('delete from companies where id=any($1::uuid[])', [
    companyIds,
  ]);
  await db.sonarPool.query('delete from users where id=$1', [actorId]);
  await db.sonarPool.query(
    'delete from registry_phones where entity_id=any($1::bigint[])',
    [entityIds],
  );
  for (const row of originals) await set(row.key, row.value);
  const { closeTaskQueue } = await import('./tasks.js');
  await closeTaskQueue();
  await Promise.all([db.sonarPool.end(), db.registryPool.end()]);
});
