import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sonarDb } from './index.js';
export async function migrateSonar() {
  await migrate(sonarDb, {
    migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
  });
}
