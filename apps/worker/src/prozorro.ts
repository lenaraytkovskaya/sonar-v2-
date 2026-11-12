import { statfs } from 'node:fs/promises';
import { extractProzorroDocument } from '@sonar/core';
import { sonarPool } from '@sonar/db';
import { saveProzorroPage, matchProzorroCompany } from '@sonar/db/prozorro';
import {
  boss,
  runTask,
  enqueueProzorroSync,
  finishEnrichment,
  TaskFailure,
  type TaskOutcome,
} from '@sonar/db/tasks';
import { ProzorroHttp, readProzorroFeed } from './prozorro-http.js';
let sharedHttp: { config: string; client: ProzorroHttp } | undefined;
export type ProzorroProgress = {
  offset: string;
  documents: number;
  rows: number;
  cursorDate: string | null;
  status: string;
  reasonUk?: string | null;
};
// A short page is not an end marker: only an empty response ends catch-up.
export async function syncProzorroPage(
  feed: 'tender' | 'contract',
  progress: ProzorroProgress,
  limit: number,
  http: Pick<ProzorroHttp, 'get'>,
  save: typeof saveProzorroPage = saveProzorroPage,
  check: () => Promise<void> = async () => {},
) {
  await check();
  const page = readProzorroFeed(
    await http.get(
      `${feed}s?limit=${limit}&offset=${encodeURIComponent(progress.offset)}`,
    ),
  );
  const documents = [];
  for (const item of page.data) {
    await check();
    const raw = await http.get(`${feed}s/${item.id}`);
    const document = extractProzorroDocument(feed, raw);
    if (document.docId !== item.id)
      throw new Error('Prozorro document ID mismatch');
    documents.push(document);
  }
  await check();
  const next = {
    ...progress,
    offset: page.next_page.offset,
    documents: progress.documents + documents.length,
    cursorDate: page.data.at(-1)?.dateModified ?? progress.cursorDate,
    status: documents.length ? 'running' : 'done',
    reasonUk: null,
  };
  const saved = await save(documents, `prozorro.${feed}.progress`, next);
  return { ...next, rows: saved.rows };
}
class SyncPaused extends Error {}
export async function runProzorroSync(payload: {
  feed: 'tender' | 'contract';
}): Promise<TaskOutcome> {
  if (!['tender', 'contract'].includes(payload.feed))
    throw new Error('Invalid Prozorro feed');
  const { feed } = payload;
  const client = await sonarPool.connect();
  let locked = false;
  let destroy = false;
  const key = `prozorro.${feed}.progress`;
  try {
    const {
      rows: [lock],
    } = await client.query(
      'select pg_try_advisory_lock(hashtextextended($1,0)) as locked',
      [key],
    );
    locked = lock.locked;
    if (!locked)
      return {
        status: 'skipped',
        reasonCode: 'prozorro_busy',
        reasonUk: 'Синхронізація цієї стрічки Prozorro вже виконується.',
      };
    const { rows } = await client.query(
      "select key,value from settings where key like 'prozorro.%' or key='scanner.user_agent'",
    );
    const config = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    const number = (name: string, minimum: number, maximum: number) => {
      const value = Number(config[`prozorro.${name}`]);
      if (!Number.isFinite(value) || value < minimum || value > maximum)
        throw new Error(`Invalid Prozorro setting: ${name}`);
      return value;
    };
    const httpConfig = {
      rate: number('rate_per_second', 0.1, 50),
      timeoutMs: number('timeout_ms', 1, 120000),
      retries: number('max_retries', 0, 10),
      retryDelayMs: number('retry_delay_ms', 1, 60000),
      userAgent: config['scanner.user_agent'],
    };
    const serialized = JSON.stringify(httpConfig);
    if (sharedHttp?.config !== serialized)
      sharedHttp = { config: serialized, client: new ProzorroHttp(httpConfig) };
    const http = sharedHttp.client;
    const check = async () => {
      const { rows: enabled } = await client.query(
        "select value from settings where key='prozorro.enabled'",
      );
      if (enabled[0]?.value !== true)
        throw new SyncPaused('Синхронізацію призупинено користувачем.');
      let disk;
      try {
        disk = await statfs(config['prozorro.disk_path']);
      } catch {
        throw new SyncPaused(
          'Не вдалося перевірити вільне місце на основному диску.',
        );
      }
      if (
        disk.bavail * disk.bsize <
          number('min_free_bytes', 0, Number.MAX_SAFE_INTEGER) ||
        disk.bavail / disk.blocks < number('min_free_ratio', 0, 1)
      )
        throw new SyncPaused(
          'Недостатньо вільного місця на основному диску. Звільніть місце й відновіть синхронізацію.',
        );
    };
    const progress = await syncProzorroPage(
      feed,
      config[key],
      number('page_size', 1, 1000),
      http,
      saveProzorroPage,
      check,
    );
    // Reuse this tracked task during backfill; pg-boss schedules the next bounded page.
    return progress.status === 'running'
      ? {
          status: 'deferred',
          runAt: new Date(),
          reasonCode: 'prozorro_backfill',
          reasonUk: 'Завантаження наступної порції Prozorro.',
        }
      : { status: 'done', result: progress };
  } catch (error) {
    const paused = error instanceof SyncPaused;
    const reasonUk = paused
      ? error.message
      : 'Не вдалося завантажити Prozorro. Курсор збережено; повторіть синхронізацію.';
    await client.query(
      "update settings set value=value||jsonb_build_object('status',$2::text,'reasonUk',$3::text),updated_at=now() where key=$1",
      [key, paused ? 'paused' : 'failed', reasonUk],
    );
    if (paused) {
      await client.query(
        "update settings set value='false',updated_at=now() where key='prozorro.enabled'",
      );
      return { status: 'paused', reasonCode: 'prozorro_paused', reasonUk };
    }
    throw new TaskFailure('prozorro_sync_failed', reasonUk);
  } finally {
    if (locked)
      try {
        await client.query(
          'select pg_advisory_unlock(hashtextextended($1,0))',
          [key],
        );
      } catch {
        destroy = true;
      }
    client.release(destroy);
  }
}
export async function registerProzorroTasks() {
  await boss.createQueue('prozorro.sync');
  await boss.createQueue('prozorro.lookup');
  await runTask('prozorro.sync', (payload) =>
    runProzorroSync(payload as { feed: 'tender' | 'contract' }),
  );
  await runTask(
    'prozorro.lookup',
    async (payload) => {
      const result = await matchProzorroCompany(
        (payload as { companyId: string }).companyId,
      );
      return { status: 'done', result };
    },
    async (payload) => {
      await finishEnrichment((payload as { companyId: string }).companyId);
    },
  );
  await boss.createQueue('sonar.prozorro.schedule');
  await boss.work('sonar.prozorro.schedule', async () => {
    await enqueueProzorroSync();
  });
  await boss.schedule('sonar.prozorro.schedule', '0 * * * *');
  await enqueueProzorroSync();
}
