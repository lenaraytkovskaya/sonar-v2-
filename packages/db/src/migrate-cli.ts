import { sonarPool, registryPool } from './index.js';
import { migrateSonar } from './migrate.js';
try {
  await migrateSonar();
} finally {
  await Promise.all([sonarPool.end(), registryPool.end()]);
}
