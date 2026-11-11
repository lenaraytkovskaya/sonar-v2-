import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';
function pool(variable: string, readOnly = false) {
  const value = process.env[variable];
  if (!value) throw new Error(`${variable} is required`);
  const url = new URL(value);
  if (readOnly)
    url.searchParams.set('options', '-c default_transaction_read_only=on');
  const client = new Pool({
    connectionString: url.toString(),
    connectionTimeoutMillis: 5000,
  });
  client.on('error', (error) =>
    console.error('Idle database connection error', error.message),
  );
  return client;
}
export const sonarPool = pool('DATABASE_URL');
export const registryPool = pool('REGISTRY_DATABASE_URL', true);
export const sonarDb = drizzle(sonarPool, { schema });
export const registryDb = drizzle(registryPool);
export { schema };
