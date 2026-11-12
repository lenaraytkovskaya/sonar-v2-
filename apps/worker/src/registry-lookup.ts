import {
  normalizeRegistryName,
  registryInitialsMatch,
  registryTables,
  type RegistryEntity,
  type RegistryEntityType,
} from '@sonar/core';
import { registryPool, sonarPool } from '@sonar/db';

export type RegistryIdentity = { type: RegistryEntityType; id: string };
export async function registryRead<T>(
  read: (client: Pick<typeof registryPool, 'query'>) => Promise<T>,
) {
  const client = await registryPool.connect();
  try {
    await client.query('begin read only');
    await client.query("set local statement_timeout = '5s'");
    const result = await read(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
const columns = `e.entity_type,e.id::text as id,e.edrpou,e.name,e.short_name,e.status,
  e.registration_date::text,e.termination_date::text,e.director,e.address,v.published_at::text`;
export function registryEntityById(identity: RegistryIdentity) {
  return registryRead(async (client) => {
    const { rows } = await client.query<RegistryEntity>(
      `select ${columns} from public.${registryTables[identity.type]} e
       left join public.edr_dataset_versions v on v.id=e.source_version_id where e.id=$1`,
      [identity.id],
    );
    return rows[0] ?? null;
  });
}

export async function registryAlternatives(companyId: string) {
  const { rows: evidence } = await sonarPool.query(
    `select kind,value from company_facts where company_id=$1 and
     ((kind='fop_name' and source='website' and (expires_at is null or expires_at>now())) or kind='registry_rejected')`,
    [companyId],
  );
  const { rows: identities } = await sonarPool.query<{
    entity_type: RegistryEntityType;
    entity_id: string;
  }>(
    `select distinct r.entity_type,r.entity_id::text from registry_phones r join contacts c on c.normalized=r.phone_e164
     where c.company_id=$1 and c.kind='phone' and c.source<>'registry'`,
    [companyId],
  );
  const candidates = new Map<
    string,
    { entity: RegistryEntity; method: string; review: boolean }
  >();
  const rejected = evidence
    .filter((row) => row.kind === 'registry_rejected')
    .map((row) => `${row.value.type}:${row.value.id}`);
  const add = (entity: RegistryEntity, method: string, review = false) => {
    const key = `${entity.entity_type}:${entity.id}`;
    if (!rejected.includes(key) && !candidates.has(key))
      candidates.set(key, { entity, method, review });
  };
  for (const identity of identities) {
    const entity = await registryEntityById({
      type: identity.entity_type,
      id: identity.entity_id,
    });
    if (entity) add(entity, 'phone');
  }
  for (const row of evidence.filter(
    (row) => row.kind === 'fop_name' && typeof row.value === 'string',
  )) {
    const name = normalizeRegistryName(row.value);
    const initials = /\p{L}\s*\./u.test(name);
    if (initials) {
      // Initials never authorize automatic binding, even with a matching phone.
      for (const candidate of candidates.values())
        if (
          candidate.entity.entity_type === 'FOP' &&
          registryInitialsMatch(name, candidate.entity.name ?? '')
        )
          candidate.review = true;
    }
    const rows = await registryRead(async (client) => {
      if (initials) {
        const {
          rows: [company],
        } = await sonarPool.query('select address from companies where id=$1', [
          companyId,
        ]);
        if (!company?.address) return [];
        // The surname prefix uses the existing trigram index; address must agree exactly.
        const result = await client.query<RegistryEntity>(
          `select ${columns} from public.edr_fops e left join public.edr_dataset_versions v on v.id=e.source_version_id
           where e.normalized_name like $1 and e.address=$2 limit 101`,
          [name.split(' ')[0] + ' %', company.address],
        );
        return result.rows.filter((entity) =>
          registryInitialsMatch(name, entity.name ?? ''),
        );
      }
      const result = await client.query<RegistryEntity>(
        `select ${columns} from public.edr_fops e left join public.edr_dataset_versions v on v.id=e.source_version_id
         where md5(e.normalized_name)=any(select md5(n) from unnest($1::text[]) n) and e.normalized_name=any($1::text[])`,
        [
          [
            ...new Set([
              name,
              name.replaceAll("'", '’'),
              name.replaceAll("'", 'ʼ'),
            ]),
          ],
        ],
      );
      return result.rows;
    });
    for (const entity of rows)
      add(entity, initials ? 'fop_initials_address' : 'fop_name', initials);
  }
  return [...candidates.values()];
}
