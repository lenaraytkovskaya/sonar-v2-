import { resolveSocialSession } from '@sonar/core/social-session';
import { sonarPool } from '@sonar/db';
import { queueSocialInboxWake } from '@sonar/db/social-inbox';
import type { SocialSessionAccount } from '@sonar/db/social-accounts';
import { connectSocialProfile } from './social-profile-browser.js';
import {
  readMessengerSnapshot,
  sweepThreads,
  THREAD_LINKS,
  watchMessenger,
} from './facebook-inbox-watch.js';
import {
  registerHotPage,
  runOnHotPage,
  unregisterHotPage,
  type HotPage,
} from './facebook-hot-page.js';

const TICK_MS = 30000;
const RETRY_MIN_MS = 30000;
const RETRY_MAX_MS = 10 * 60 * 1000;
const BLOCKED_RETRY_MS = 10 * 60 * 1000;

interface Listener {
  stop: boolean;
  done: Promise<void>;
  wakes: number;
  seen?: Record<string, unknown>;
}

// Operators read this from the accounts API to see what the listener is doing.
async function report(accountId: string, patch: Record<string, unknown>) {
  await sonarPool
    .query(
      "update channel_accounts set settings=jsonb_set(settings,'{inboxListener}',coalesce(settings->'inboxListener','{}'::jsonb)||$2::jsonb) where id=$1",
      [accountId, JSON.stringify({ ...patch, at: new Date().toISOString() })],
    )
    .catch(() => {});
}

export function startFacebookInboxListener(timeout: () => Promise<number>) {
  const listeners = new Map<string, Listener>();
  const retryAt = new Map<string, number>();
  const failures = new Map<string, number>();
  let closed = false;

  async function setting<T>(key: string, fallback: T) {
    const {
      rows: [row],
    } = await sonarPool.query('select value from settings where key=$1', [key]);
    return (row?.value as T | undefined) ?? fallback;
  }

  // Opens the top chats now and then and wakes the sync when one of them moved.
  function startSweeper(accountId: string, hot: HotPage, listener: Listener) {
    const seen = new Map<string, string>();
    let running = false;
    let stopped = false;
    const run = async () => {
      if (running || stopped || listener.stop || closed) return;
      running = true;
      try {
        const every =
          Number(await setting('social.inbox.listen_sweep_seconds', 20)) * 1000;
        if (Date.now() - lastSweep < every) return;
        const changed = await runOnHotPage(hot, async (page) => {
          const snapshot = await readMessengerSnapshot(page);
          const hrefs = (snapshot.threads ?? [])
            .slice(0, 3)
            .map((thread) => thread.href);
          lastSweep = Date.now();
          return sweepThreads(page, hrefs, seen, 15000);
        });
        if (changed.length) {
          for (const href of changed) hot.dirty.add(href);
          listener.wakes++;
          const wake = await queueSocialInboxWake(accountId);
          await report(accountId, {
            wakes: listener.wakes,
            lastWakeAt: new Date().toISOString(),
            lastWake: `sweep:${wake}`,
          });
        }
      } catch (error) {
        await report(accountId, {
          lastWakeError:
            error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        });
      } finally {
        running = false;
      }
    };
    let lastSweep = 0;
    const timer = setInterval(() => void run(), 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  async function listen(account: SocialSessionAccount, listener: Listener) {
    const session = resolveSocialSession(account as never);
    const { context } = await connectSocialProfile(account, session as never);
    const page = await context.newPage();
    let hot: HotPage | undefined;
    let sweeper: (() => void) | undefined;
    try {
      const timeoutMs = await timeout();
      page.setDefaultTimeout(timeoutMs);
      for (;;) {
        await page.goto('https://www.facebook.com/messages/', {
          waitUntil: 'domcontentloaded',
          timeout: timeoutMs,
        });
        await page
          .locator(THREAD_LINKS)
          .first()
          .waitFor({ timeout: timeoutMs });
        failures.delete(account.id);
        if (!hot) {
          hot = registerHotPage(account.id, page);
          sweeper = startSweeper(account.id, hot, listener);
        }
        await report(account.id, { state: 'watching', error: null });
        const minGapMs =
          Number(await setting('social.inbox.listen_min_gap_seconds', 15)) *
          1000;
        const end = await watchMessenger(page, {
          minGapMs,
          onScan: (snapshot) => {
            listener.seen = {
              unread: snapshot.unread,
              threads: snapshot.threads?.length ?? 0,
              openLast: snapshot.open?.last ?? '',
              page: snapshot.page,
              tabs: page
                .context()
                .pages()
                .map((tab) => {
                  try {
                    return new URL(tab.url()).pathname.slice(0, 40);
                  } catch {
                    return '?';
                  }
                }),
            };
          },
          stopped: () => listener.stop || closed,
          onChange: async (changed) => {
            for (const href of changed) hot?.dirty.add(href);
            try {
              listener.wakes++;
              // A running sync cannot be moved up; ask again until it has
              // finished so the change is not left for the regular interval.
              let wake = await queueSocialInboxWake(account.id);
              for (let tries = 0; wake === 'running' && tries < 12; tries++) {
                await new Promise((resolve) => setTimeout(resolve, 5000));
                if (listener.stop || closed) break;
                wake = await queueSocialInboxWake(account.id);
              }
              await report(account.id, {
                wakes: listener.wakes,
                lastWakeAt: new Date().toISOString(),
                lastWake: wake,
              });
            } catch (error) {
              await report(account.id, {
                lastWakeError:
                  error instanceof Error
                    ? error.message.slice(0, 200)
                    : 'unknown',
              });
            }
          },
        });
        if (end === 'blocked') {
          await report(account.id, { state: 'blocked' });
          retryAt.set(account.id, Date.now() + BLOCKED_RETRY_MS);
          console.warn('facebook inbox listener stopped: login or PIN dialog', {
            accountId: account.id,
          });
          return;
        }
        if (end === 'stopped') return;
      }
    } finally {
      sweeper?.();
      if (hot) unregisterHotPage(hot);
      await page.close().catch(() => {});
    }
  }

  async function tick() {
    if (closed) return;
    const enabled =
      (await setting('social.inbox.enabled', false)) === true &&
      (await setting('social.inbox.facebook.enabled', false)) === true &&
      (await setting('social.inbox.listen_enabled', true)) === true;
    const { rows } = enabled
      ? await sonarPool.query<SocialSessionAccount>(
          `select id,channel,settings from channel_accounts
           where channel='facebook' and status='active'
           and settings->>'sessionStatus'='valid'
           and coalesce(settings->>'enabled','true')<>'false'
           and settings->>'inboxPollingEnabled'='true'
           and settings->>'browserProfile'='true'`,
        )
      : { rows: [] as SocialSessionAccount[] };
    const wanted = new Set(rows.map((row) => row.id));
    for (const [id, listener] of listeners) {
      if (!wanted.has(id)) listener.stop = true;
      else if (listener.seen) void report(id, { seen: listener.seen });
    }
    for (const account of rows) {
      if (listeners.has(account.id)) continue;
      if ((retryAt.get(account.id) ?? 0) > Date.now()) continue;
      const listener: Listener = {
        stop: false,
        done: Promise.resolve(),
        wakes: 0,
      };
      void report(account.id, { state: 'starting', error: null });
      listener.done = listen(account, listener)
        .catch((error) => {
          const count = (failures.get(account.id) ?? 0) + 1;
          failures.set(account.id, count);
          retryAt.set(
            account.id,
            Date.now() +
              Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(count, 5)),
          );
          void report(account.id, {
            state: 'error',
            error:
              error instanceof Error ? error.message.slice(0, 200) : 'unknown',
          });
          console.warn('facebook inbox listener failed', {
            accountId: account.id,
            message: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          listeners.delete(account.id);
        });
      listeners.set(account.id, listener);
    }
  }

  const timer = setInterval(() => {
    void tick().catch((error) =>
      console.warn('facebook inbox listener tick failed', error),
    );
  }, TICK_MS);
  void tick().catch(() => {});
  return async () => {
    closed = true;
    clearInterval(timer);
    for (const listener of listeners.values()) listener.stop = true;
    await Promise.all([...listeners.values()].map((l) => l.done));
  };
}
