import { registerInboundTasks } from './inbound.js';
import { registerSocialInboxTasks } from './social-inbox.js';
import { createSocialInboxAdapter } from './instagram-inbox-browser.js';
import { socialPageTimeout } from './social-send.js';
import { registerSocialTasks, closeSocialBrowser } from './social.js';
import {
  registerSocialSessionTasks,
  closeSocialSendBrowser,
} from './social-send.js';
import { closeTelegramClients } from './telegram.js';
import { registerEmailTasks } from './email.js';
import { registerAnalysisTasks } from './analysis.js';
import { registerDraftTasks } from './drafts.js';
import { registerScoringTasks } from './scoring.js';
import { registerSiteTasks } from './site.js';
import { registerRegistryTasks } from './registry.js';
import { registerProzorroTasks } from './prozorro.js';
import { registerGoogleTasks } from './google.js';
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
  await registerEmailTasks();
  await registerInboundTasks();
  await registerSocialInboxTasks(createSocialInboxAdapter(socialPageTimeout));
  await registerDraftTasks();
  await registerAnalysisTasks();
  await registerScoringTasks();
  await registerAiTasks();
  await registerGoogleTasks();
  await registerProzorroTasks();
  await registerRegistryTasks();
  await registerSocialTasks();
  await registerSocialSessionTasks();
  await registerSiteTasks();
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
  await closeTelegramClients();
  await closeTaskQueue();
  await closeSocialBrowser();
  await closeSocialSendBrowser();
  await Promise.all([sonarPool.end(), registryPool.end()]);
}
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => void stop());
started.catch((error) => {
  console.error('worker startup failed', error);
  process.exitCode = 1;
  void stop();
});
