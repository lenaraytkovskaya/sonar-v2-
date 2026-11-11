import { registerAiTasks } from './ai.js';
import { sonarPool, registryPool } from '@sonar/db';
import { readRegistryEstimates } from './registry-ping.js';
import {
  boss,
  queueName,
  runTask,
  enqueueTask,
  TaskFailure,
  closeTaskQueue,
} from '@sonar/db/tasks';
let stopping = false;
const started = (async () => {
  await boss.start();
  await boss.createQueue(queueName);
  await registerAiTasks();
  await boss.createQueue('sonar.registry.schedule');
  await runTask('system.registry_ping', async () => {
    try {
      const result = await readRegistryEstimates(registryPool);
      return { status: 'done', result };
    } catch {
      throw new TaskFailure(
        'registry_unavailable',
        'Не вдалося прочитати реєстр ЄДР. Перевірте підключення до реєстру та повторіть.',
      );
    }
  });
  const enqueue = () =>
    enqueueTask(
      'system.registry_ping',
      `registry:${new Date().toISOString().slice(0, 13)}`,
    );
  await boss.work('sonar.registry.schedule', async () => {
    await enqueue();
  });
  await boss.schedule('sonar.registry.schedule', '0 * * * *');
  await enqueue();
  console.log('worker started');
})();
async function stop() {
  if (stopping) return;
  stopping = true;
  await started.catch(() => {});
  await closeTaskQueue();
  await Promise.all([sonarPool.end(), registryPool.end()]);
}
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => void stop());
started.catch((error) => {
  console.error('worker startup failed', error);
  process.exitCode = 1;
  void stop();
});
