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
  normalizeRegistryName,
  type RegistryEntity,
  type RegistryEntityType,
} from '@sonar/core';
import { sonarPool, registryPool } from '@sonar/db';
import {
  boss,
  runTask,
  logActivity,
  enqueueProzorroLookup,
  type TaskOutcome,
} from '@sonar/db/tasks';
type Query = Pick<typeof registryPool, 'query'>;

const legalNameNoise = new Set([
  'тов',
  'тзов',
  'приватне',
  'підприємство',
  'підприємства',
  'компанія',
  'компанії',
  'україна',
  'центр',
  'центрів',
  'сервіс',
  'група',
  'клініка',
  'клиника',
  'clinic',
  'стоматологія',
  'стоматологічна',
  'салон',
  'салони',
  'beauty',
  'dental',
  'студія',
  'studio',
  'юридична',
  'юридичні',
  'адвокатське',
  'адвокат',
  'медичний',
]);
const cyrillic = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'h',
  ґ: 'g',
  д: 'd',
  е: 'e',
  є: 'ye',
  ж: 'zh',
  з: 'z',
  и: 'y',
  і: 'i',
  ї: 'yi',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ь: '',
  ю: 'yu',
  я: 'ya',
};

export function registryFooterNameMatches(
  companyName: string,
  domain: string | null,
  registryName: string | null,
  shortName: string | null,
) {
  const tokens = (value: string) =>
    normalizeRegistryName(value)
      .replace(
        /[а-яіїєґ]/gu,
        (letter) => cyrillic[letter as keyof typeof cyrillic],
      )
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(/\s+/u)
      .filter((token) => token.length >= 4 && !legalNameNoise.has(token));
  const companyTokens = tokens(companyName);
  const registryTokens = [registryName, shortName]
    .filter((value): value is string => Boolean(value))
    .flatMap(tokens);
  const common = companyTokens.some((token) => registryTokens.includes(token));
  if (common) return true;
  if (!domain) return false;
  const domainName = domain
    .replace(/^https?:\/\//i, '')
    .split(/[/?#]/u, 1)[0]!
    .replace(/^www\./i, '')
    .split('.')
    .filter(
      (part) =>
        !['com', 'org', 'net', 'ua', 'co', 'kiev', 'kyiv'].includes(part),
    )
    .join(' ');
  const domainTokens = tokens(domainName);
  return domainTokens.some((token) => registryTokens.includes(token));
}

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
    manualCode?: string;
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
    'select c.id,c.name,c.domain,c.country_code,(select ca.country_code from campaign_companies cc join campaigns ca on ca.id=cc.campaign_id where cc.company_id=c.id order by cc.added_at desc limit 1) as campaign_country from companies c where c.id=$1',
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
  const codeSources = payload.manualCode
    ? "'website','ai','manual','registry'"
    : "'website','ai','manual'";
  const { rows: evidence } = await sonarPool.query(
    `select value from company_facts where company_id=$1 and kind='edrpou' and source in (${codeSources}) order by found_at desc`,
    [companyId],
  );
  const evidenceCodes = registryCodes(evidence.map((row) => row.value));
  const codes = payload.manualCode ? [payload.manualCode] : evidenceCodes;
  const { rows: footerEvidence } =
    codes.length || payload.candidate
      ? { rows: [] }
      : await sonarPool.query(
          "select value from company_facts where company_id=$1 and kind='footer_edrpou' and source='website' and (expires_at is null or expires_at>now()) order by found_at desc",
          [companyId],
        );
  const footerCodes = registryCodes(footerEvidence.map((row) => row.value));
  if (payload.manualCode && !evidenceCodes.includes(payload.manualCode))
    return {
      status: 'skipped',
      reasonCode: 'registry_code_changed',
      reasonUk:
        'Код ЄДР змінено після запуску. Збережіть актуальний код і повторіть.',
    };
  const identityChanged = async (client: Pick<typeof sonarPool, 'query'>) => {
    const { rows: currentEvidence } = await client.query(
      `select value from company_facts where company_id=$1 and kind='edrpou' and source in (${codeSources})`,
      [companyId],
    );
    const currentCodes = registryCodes(currentEvidence.map((row) => row.value));
    const changedCodes =
      JSON.stringify([...currentCodes].sort()) !==
      JSON.stringify([...evidenceCodes].sort());
    if (!footerCodes.length) return changedCodes;
    const { rows: currentFooter } = await client.query(
      "select value from company_facts where company_id=$1 and kind='footer_edrpou' and source='website' and (expires_at is null or expires_at>now())",
      [companyId],
    );
    return (
      changedCodes ||
      JSON.stringify(
        registryCodes(currentFooter.map((row) => row.value)).sort(),
      ) !== JSON.stringify([...footerCodes].sort())
    );
  };
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
  } else if (footerCodes.length) {
    const possible: NonNullable<Awaited<ReturnType<typeof lookupRegistry>>>[] =
      [];
    for (const code of footerCodes) {
      const footerMatch = await lookup(registryPool, code);
      if (!footerMatch) continue;
      if (
        registryFooterNameMatches(
          company.name,
          company.domain,
          footerMatch.entity.name,
          footerMatch.entity.short_name,
        )
      ) {
        match = footerMatch;
        method = 'footer_code_name';
        break;
      }
      possible.push(footerMatch);
    }
    if (!match && possible.length) {
      let reviewable = possible;
      const client = await sonarPool.connect();
      try {
        await client.query('begin');
        await client.query('select id from companies where id=$1 for update', [
          companyId,
        ]);
        const { rows: choices } = await client.query(
          "select 1 from company_facts where company_id=$1 and kind='registry_match_method' and value='\"confirmed\"'::jsonb",
          [companyId],
        );
        if (!choices.length) {
          await client.query(
            "delete from company_facts where company_id=$1 and kind='registry_candidates'",
            [companyId],
          );
          const { rows: rejected } = await client.query(
            "select value from company_facts where company_id=$1 and kind='registry_rejected'",
            [companyId],
          );
          const rejectedKeys = rejected.map(
            (row) => `${row.value?.type}:${row.value?.id}`,
          );
          reviewable = possible.filter(
            ({ entity }) =>
              !rejectedKeys.includes(`${entity.entity_type}:${entity.id}`),
          );
          if (reviewable.length)
            await client.query(
              `insert into company_facts(company_id,kind,value,source)
               values($1,'registry_candidates',$2::jsonb,'registry')`,
              [
                companyId,
                JSON.stringify(reviewable.map(({ entity }) => entity)),
              ],
            );
        }
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
      if (reviewable.length)
        return {
          status: 'skipped',
          reasonCode: 'registry_footer_candidate',
          reasonUk:
            'Можливий збіг у ЄДР. Потрібне підтвердження у картці компанії.',
        };
    }
  }
  if (!match && !payload.candidate && !codes.length) {
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
        if (await identityChanged(client)) {
          await client.query('rollback');
          return {
            status: 'skipped',
            reasonCode: 'registry_code_changed',
            reasonUk:
              'Код ЄДР змінено під час пошуку. Повторіть аналіз актуального коду.',
          };
        }
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
    if (await identityChanged(client)) {
      await client.query('rollback');
      return {
        status: 'skipped',
        reasonCode: 'registry_code_changed',
        reasonUk:
          'Код ЄДР змінено під час пошуку. Повторіть аналіз актуального коду.',
      };
    }
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
      await enqueueProzorroLookup((payload as { companyId: string }).companyId);
    },
  );
}
