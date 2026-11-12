import {
  registryAlternatives,
  registryEntityById,
  registryRead,
  type RegistryIdentity,
} from './registry-lookup.js';
import { registerRegistryPhoneTasks } from './registry-phones.js';
import {
  pickRegistryEntity,
  registryCodes,
  registryContacts,
  registryFacts,
  registryTables,
  registryTerminated,
  type RegistryEntity,
  type RegistryEntityType,
} from '@sonar/core';
import { sonarPool, registryPool } from '@sonar/db';
import {
  boss,
  runTask,
  logActivity,
  finishEnrichment,
  type TaskOutcome,
} from '@sonar/db/tasks';
type Query = Pick<typeof registryPool, 'query'>;

// Read-only, indexed lookups only: edrpou btree indexes and (entity_type, entity_id) unique keys.
export async function lookupRegistry(pool: typeof registryPool, code: string) {
  const client = await pool.connect();
  try {
    await client.query('begin read only');
    await client.query("set local statement_timeout = '5s'");
    const rows: RegistryEntity[] = [];
    for (const [type, table] of Object.entries(registryTables)) {
      const { rows: found } = await client.query(
        `select '${type}' as entity_type,e.id::text as id,e.edrpou,e.name,e.short_name,e.status,
          e.registration_date::text as registration_date,e.termination_date::text as termination_date,
          e.director,e.address,v.published_at::text as published_at
         from public.${table} e left join public.edr_dataset_versions v on v.id=e.source_version_id
         where e.edrpou=$1 limit 5`,
        [code],
      );
      rows.push(...found);
    }
    const entity = pickRegistryEntity(rows);
    if (!entity) {
      await client.query('commit');
      return null;
    }
    const details = await registryDetails(
      client,
      entity.entity_type,
      entity.id,
    );
    await client.query('commit');
    return { entity, ...details };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
async function registryDetails(
  client: Query,
  type: RegistryEntityType,
  id: string,
) {
  const [{ rows: founders }, { rows: contacts }] = await Promise.all([
    client.query(
      'select role,name,share,country from public.edr_founders where entity_type=$1 and entity_id=$2 order by id limit 20',
      [type, id],
    ),
    client.query(
      'select kind,value,normalized_value,confidence from public.edr_contacts where entity_type=$1 and entity_id=$2 order by confidence desc limit 20',
      [type, id],
    ),
  ]);
  return { founders, contacts };
}

export async function runRegistryMatch(
  payload: {
    companyId: string;
    candidate?: RegistryIdentity;
    actorId?: string;
  },
  taskId: string,
  lookup: typeof lookupRegistry = lookupRegistry,
  alternatives: typeof registryAlternatives = registryAlternatives,
  byId: typeof registryEntityById = registryEntityById,
): Promise<TaskOutcome> {
  const { companyId } = payload;
  const {
    rows: [company],
  } = await sonarPool.query(
    'select c.id,c.country_code,(select ca.country_code from campaign_companies cc join campaigns ca on ca.id=cc.campaign_id where cc.company_id=c.id order by cc.added_at desc limit 1) as campaign_country from companies c where c.id=$1',
    [companyId],
  );
  if (!company)
    return {
      status: 'skipped',
      reasonCode: 'company_missing',
      reasonUk: 'Компанію не знайдено.',
    };
  if ((company.country_code ?? company.campaign_country) !== 'UA')
    return {
      status: 'skipped',
      reasonCode: 'registry_country',
      reasonUk: 'Реєстр для країни компанії ще не підключено.',
    };
  const { rows: evidence } = await sonarPool.query(
    "select value from company_facts where company_id=$1 and kind='edrpou' and source in ('website','ai','manual') order by found_at desc",
    [companyId],
  );
  const codes = registryCodes(evidence.map((row) => row.value));
  let match: Awaited<ReturnType<typeof lookupRegistry>> = null;
  let method = 'code';
  if (payload.candidate) {
    if (
      !Object.hasOwn(registryTables, payload.candidate.type) ||
      !/^\d+$/.test(payload.candidate.id)
    )
      throw new Error('Некоректний кандидат ЄДР.');
    const entity = await byId(payload.candidate);
    if (entity)
      match = {
        entity,
        ...(await registryRead((client) =>
          registryDetails(client, entity.entity_type, entity.id),
        )),
      };
    method = 'confirmed';
  } else if (codes.length) {
    for (const code of codes) {
      match = await lookup(registryPool, code);
      if (match) break;
    }
  } else {
    const candidates = await alternatives(companyId);
    const active = candidates.filter(
      ({ entity }) =>
        !entity.termination_date &&
        !registryTerminated(entity.status) &&
        /^(зареєстровано|діючий|діюча|діюче|active|registered)$/i.test(
          entity.status?.trim() ?? '',
        ),
    );
    if (active.length === 1 && !active[0]!.review) {
      const { entity } = active[0]!;
      method = active[0]!.method;
      match = {
        entity,
        ...(await registryRead((client) =>
          registryDetails(client, entity.entity_type, entity.id),
        )),
      };
    } else if (candidates.length) {
      const client = await sonarPool.connect();
      try {
        await client.query('begin');
        await client.query('select id from companies where id=$1 for update', [
          companyId,
        ]);
        // A confirmed/manual choice is authoritative over concurrent automatic matching.
        const { rows: choices } = await client.query(
          "select 1 from company_facts where company_id=$1 and kind='registry_match_method' and value='\"confirmed\"'::jsonb",
          [companyId],
        );
        if (!choices.length) {
          await client.query(
            "delete from company_facts where company_id=$1 and kind='registry_candidates'",
            [companyId],
          );
          await client.query(
            `insert into company_facts(company_id,kind,value,source)
            select $1,'registry_candidates',coalesce(jsonb_agg(candidate),'[]'::jsonb),'registry' from jsonb_array_elements($2::jsonb) candidate where not exists(select 1 from company_facts r where r.company_id=$1 and r.kind='registry_rejected' and r.value=jsonb_build_object('type',candidate->>'entity_type','id',candidate->>'id'))`,
            [companyId, JSON.stringify(candidates.map((c) => c.entity))],
          );
        }
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
      return {
        status: 'skipped',
        reasonCode: 'registry_candidates',
        reasonUk:
          'Знайдено можливі збіги ЄДР. Потрібне підтвердження у картці компанії.',
      };
    }
  }
  if (!match)
    return {
      status: 'skipped',
      reasonCode: 'registry_not_found',
      reasonUk: 'В ЄДР не знайдено збіг за кодом, телефонами або ПІБ ФОП.',
    };
  const { entity, founders, contacts } = match;
  const {
    rows: [retention],
  } = await sonarPool.query(
    "select value from settings where key='retention.registry_days'",
  );
  const days = Number(retention?.value ?? 365);
  const facts = [
    ...registryFacts(entity, founders),
    { kind: 'registry_match_method', value: method },
  ];
  const found = registryContacts(contacts);
  const client = await sonarPool.connect();
  try {
    await client.query('begin');
    await client.query('select id from companies where id=$1 for update', [
      companyId,
    ]);
    if (payload.candidate) {
      const { rows } = await client.query(
        `select 1 from company_facts where company_id=$1 and kind='registry_candidates'
        and value @> $2::jsonb`,
        [
          companyId,
          JSON.stringify([{ entity_type: entity.entity_type, id: entity.id }]),
        ],
      );
      if (!rows.length) {
        await client.query('rollback');
        return {
          status: 'skipped',
          reasonCode: 'registry_candidate_stale',
          reasonUk: 'Кандидат більше не очікує підтвердження.',
        };
      }
    } else {
      const { rows } = await client.query(
        "select 1 from company_facts where company_id=$1 and kind='registry_match_method' and value='\"confirmed\"'::jsonb",
        [companyId],
      );
      if (rows.length) {
        await client.query('rollback');
        return {
          status: 'skipped',
          reasonCode: 'registry_already_confirmed',
          reasonUk: 'Збіг ЄДР уже підтверджено користувачем.',
        };
      }
    }
    if (!payload.candidate) {
      const { rows } = await client.query(
        "select 1 from company_facts where company_id=$1 and kind='registry_rejected' and value=$2::jsonb",
        [
          companyId,
          JSON.stringify({ type: entity.entity_type, id: entity.id }),
        ],
      );
      if (rows.length) {
        await client.query('rollback');
        return {
          status: 'skipped',
          reasonCode: 'registry_candidate_rejected',
          reasonUk: 'Цей збіг ЄДР відхилено користувачем.',
        };
      }
    }
    // A new match replaces the previous registry snapshot for this company.
    await client.query(
      "delete from company_facts where company_id=$1 and source='registry'",
      [companyId],
    );
    for (const fact of facts)
      await client.query(
        `insert into company_facts(company_id,kind,value,source,source_url,expires_at) values($1,$2,$3,'registry',null,now()+$4*interval '1 day') on conflict(company_id,kind,source,(md5(value::text))) do update set found_at=now(),expires_at=excluded.expires_at`,
        [companyId, fact.kind, JSON.stringify(fact.value), days],
      );
    for (const contact of found)
      await client.query(
        `insert into contacts(company_id,kind,value,normalized,source,source_url,rank,meta) values($1,$2,$3,$4,'registry',null,$5,$6)
         on conflict(company_id,kind,normalized) do update set meta=contacts.meta||case when contacts.source<>'registry' then '{"alsoInRegistry":true}'::jsonb else excluded.meta end`,
        [
          companyId,
          contact.kind,
          contact.value,
          contact.normalized,
          Math.round(20 + contact.confidence * 20),
          { confidence: contact.confidence, published: entity.published_at },
        ],
      );
    await logActivity(
      payload.candidate ? 'registry.candidate.confirmed' : 'registry.match',
      'company',
      companyId,
      payload.actorId ?? null,
      {
        taskId,
        method,
        entityId: entity.id,
        edrpou: entity.edrpou,
        entityType: entity.entity_type,
        contacts: found.length,
      },
      client,
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
  return {
    status: 'done',
    result: {
      edrpou: entity.edrpou,
      entityType: entity.entity_type,
      status: entity.status,
      contacts: found.length,
      published: entity.published_at,
    },
  };
}
export async function registerRegistryTasks() {
  await registerRegistryPhoneTasks();
  await boss.createQueue('registry.match');
  await runTask(
    'registry.match',
    async (payload, id) => {
      return runRegistryMatch(payload as { companyId: string }, id);
    },
    async (payload) => {
      await finishEnrichment((payload as { companyId: string }).companyId);
    },
  );
}
