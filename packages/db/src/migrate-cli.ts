import { PgBoss } from 'pg-boss';
import { sonarPool, registryPool } from './index.js';
import { migrateSonar } from './migrate.js';
const queue = new PgBoss({
  connectionString: process.env.DATABASE_URL,
  supervise: false,
  schedule: false,
});
queue.on('error', (error) =>
  console.error('queue migration error', error.message),
);
try {
  await migrateSonar();
  await queue.start();
} finally {
  await queue.stop();
  await Promise.all([sonarPool.end(), registryPool.end()]);
}
