import type { registryPool } from '@sonar/db';

export async function readRegistryEstimates(
  pool: Pick<typeof registryPool, 'query'>,
) {
  // Read only the catalog, never scan the EDR tables. -1 means not analyzed yet.
  const { rows } = await pool.query<{
    table: string;
    count: string | null;
  }>(
    `select relname as "table",
       case when reltuples < 0 then null else reltuples::bigint::text end as count
     from pg_class where oid = any($1::regclass[])`,
    [
      [
        'public.edr_legal_entities',
        'public.edr_fops',
        'public.edr_founders',
        'public.edr_public_organizations',
        'public.edr_branches',
      ],
    ],
  );
  return {
    approximate: true,
    counts: Object.fromEntries(rows.map((row) => [row.table, row.count])),
  };
}
