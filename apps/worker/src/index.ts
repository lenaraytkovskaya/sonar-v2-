import { sonarPool, registryPool } from '@sonar/db';
import { migrateSonar } from '@sonar/db/migrate';
const keepAlive = setInterval(() => {}, 60_000);
let stopping = false;
const started = (async () => {
  await migrateSonar();
  await sonarPool.query('select 1');
  if (!stopping) console.log('worker started');
})();
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(keepAlive);
  await started.catch(() => {});
  await Promise.all([sonarPool.end(), registryPool.end()]);
}
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => void stop());
started.catch((error: unknown) => {
  console.error('worker startup failed', error);
  process.exitCode = 1;
  void stop();
});
