import type { BrowserContext } from 'playwright';
import { facebookSendNetwork } from './facebook-send-network.js';
import { resolveSocialSession } from '@sonar/core/social-session';
import { sonarPool } from '@sonar/db';
import { queueSocialInboxWake } from '@sonar/db/social-inbox';
import type { SocialSessionAccount } from '@sonar/db/social-accounts';
import { connectSocialProfile } from './social-profile-browser.js';
import { probeNetwork } from './network-probe.js';
import {
  focusThread,
  MessengerSignalCooldown,
  readMessengerSnapshot,
  sweepThreads,
  THREAD_LINKS,
  watchMessenger,
} from './facebook-inbox-watch.js';
import {
  registerHotPage,
  runOnHotPage,
  unregisterHotPage,
  waitForFacebookRead,
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
  events: string[];
}

const note = (listener: Listener, line: string) => {
  listener.events.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (listener.events.length > 40) listener.events.shift();
};

const safeFailure = (error: unknown) =>
  error instanceof Error && error.name === 'TimeoutError'
    ? 'timeout'
    : error instanceof Error && error.message === 'facebook_read_preempted'
      ? 'send_priority'
      : 'browser_operation_failed';
const safePagePath = (url: string) => {
  try {
    const path = new URL(url).pathname;
    return /^\/messages(?:\/e2ee)?\/t\/[^/]+\/?$/.test(path)
      ? '/messages/t/<redacted>'
      : /^\/messages\/?$/.test(path)
        ? '/messages/'
        : '/<redacted>';
  } catch {
    return '/<redacted>';
  }
};

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
    // Sweeps that keep failing mean Facebook is slow or throttling: ease off.
    let failStreak = 0;
    const run = async () => {
      if (running || stopped || listener.stop || closed) return;
      running = true;
      try {
        const every =
          Number(await setting('social.inbox.listen_sweep_seconds', 20)) * 1000;
        const wait = Math.min(15 * 60000, every * 2 ** Math.min(failStreak, 5));
        if (Date.now() - lastSweep < wait) return;
        if (hot.pendingSends > 0 || hot.activeOps > 0) return;
        const changed = await runOnHotPage(hot, async (page) => {
          const snapshot = await readMessengerSnapshot(page);
          const all = (snapshot.threads ?? [])
            .slice(0, 3)
            .map((thread) => thread.href);
          if (!all.length) return [];
          // One chat per sweep keeps the page free for sends; they take turns.
          const hrefs = [all[turn++ % all.length]!];
          lastSweep = Date.now();
          hot.primary ??= all[0];
          let failed = false;
          const found = await sweepThreads(
            page,
            hrefs,
            seen,
            20000,
            (line) => {
              note(listener, line);
              if (line.includes(' failed ')) failed = true;
            },
            () => hot.pendingSends > 0,
          );
          failStreak = failed ? failStreak + 1 : 0;
          // Rest on the active chat so its new messages arrive live.
          if (hot.primary && hot.pendingSends === 0)
            await focusThread(page, hot.primary, 8000);
          return found;
        });
        if (changed.length) {
          for (const href of changed) hot.dirty.add(href);
          listener.wakes++;
          let wake = await queueSocialInboxWake(accountId);
          for (let tries = 0; wake === 'running' && tries < 12; tries++) {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            if (stopped || listener.stop || closed) break;
            wake = await queueSocialInboxWake(accountId);
          }
          await report(accountId, {
            wakes: listener.wakes,
            lastWakeAt: new Date().toISOString(),
            lastWake: `sweep:${wake}`,
          });
        }
      } catch (error) {
        await report(accountId, {
          lastWakeError: safeFailure(error),
        });
      } finally {
        running = false;
      }
    };
    let lastSweep = 0;
    let turn = 0;
    const timer = setInterval(() => void run(), 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  // Measures how the profile browser's connection behaves, every few minutes.
  function startProbe(
    accountId: string,
    context: BrowserContext,
    hot: HotPage,
  ) {
    let running = false;
    let stopped = false;
    const run = async () => {
      if (running || stopped || closed || hot.pendingSends > 0) return;
      running = true;
      try {
        const results = await probeNetwork(context);
        await report(accountId, {
          net: { ...results, probedAt: new Date().toISOString() },
        });
      } catch {
        // A failed probe is just a missing data point.
      } finally {
        running = false;
      }
    };
    const first = setTimeout(() => void run(), 20000);
    const timer = setInterval(() => void run(), 180000);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
    };
  }

  async function listen(account: SocialSessionAccount, listener: Listener) {
    const session = resolveSocialSession(account as never);
    const { context } = await connectSocialProfile(account, session as never);
    const page = await context.newPage();
    facebookSendNetwork(page);
    const signalCooldown = new MessengerSignalCooldown();
    // Encrypted chats keep one active Messenger tab per profile. Tabs left by a
    // previous worker process (a deploy kills it mid-run) silence this one, so
    // they are closed - but only after our own tab exists: closing the last
    // window would shut the whole profile browser down.
    for (const stale of context.pages())
      if (
        stale !== page &&
        /^https:\/\/(?:www\.)?facebook\.com\/(?:messages|home\.php)/.test(
          stale.url(),
        )
      )
        await stale.close().catch(() => {});
    let hot: HotPage | undefined;
    let sweeper: (() => void) | undefined;
    let stopProbe: (() => void) | undefined;
    try {
      const timeoutMs = await timeout();
      page.setDefaultTimeout(timeoutMs);
      for (;;) {
        const reload = async () => {
          await waitForFacebookRead(
            page,
            () =>
              page.goto('https://www.facebook.com/messages/', {
                waitUntil: 'domcontentloaded',
                timeout: timeoutMs,
              }),
            true,
          );
          await waitForFacebookRead(page, () =>
            page.locator(THREAD_LINKS).first().waitFor({ timeout: timeoutMs }),
          );
        };
        if (hot) {
          try {
            await runOnHotPage(hot, reload);
          } catch (error) {
            if (
              !(error instanceof Error) ||
              error.message !== 'facebook_read_preempted'
            )
              throw error;
            await new Promise((resolve) => setTimeout(resolve, 100));
            continue;
          }
        } else await reload();
        failures.delete(account.id);
        if (!hot) {
          hot = registerHotPage(account.id, page);
          sweeper = startSweeper(account.id, hot, listener);
          stopProbe = startProbe(account.id, context, hot);
        }
        await report(account.id, { state: 'watching', error: null });
        const minGapMs =
          Number(await setting('social.inbox.listen_min_gap_seconds', 15)) *
          1000;
        const end = await watchMessenger(page, {
          minGapMs,
          signalCooldown,
          signalCooldownMs:
            Number(
              await setting('social.inbox.listen_signal_cooldown_seconds', 120),
            ) * 1000,
          onEvent: (line) => note(listener, line),
          paused: () =>
            (hot?.activeOps ?? 0) > 0 || (hot?.pendingSends ?? 0) > 0,
          onScan: (snapshot) => {
            listener.seen = {
              unread: snapshot.unread,
              threads: snapshot.threads?.length ?? 0,
              openLast: snapshot.open?.last ? 'observed' : '',
              log: [...listener.events, ...(hot?.events ?? [])]
                .sort()
                .slice(-16),
              page: snapshot.page
                ? {
                    path: safePagePath(page.url()),
                    hidden: snapshot.page.hidden,
                    dialogPresent: Boolean(snapshot.page.dialog),
                    noteCount: snapshot.page.notes.length,
                  }
                : undefined,
              tabs: page
                .context()
                .pages()
                .map((tab) => safePagePath(tab.url())),
            };
          },
          stopped: () => listener.stop || closed,
          onChange: async (changed) => {
            for (const href of changed) hot?.dirty.add(href);
            if (hot && changed[0]) hot.primary = changed[0];
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
                lastWakeError: safeFailure(error),
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
      stopProbe?.();
      if (hot) unregisterHotPage(hot);
      // Never close the last window: that would shut the whole profile browser.
      if (context.pages().length > 1) await page.close().catch(() => {});
      else await page.goto('about:blank').catch(() => {});
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
        events: [],
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
            error: safeFailure(error),
          });
          console.warn('facebook inbox listener failed', {
            accountId: account.id,
            reason: safeFailure(error),
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
      console.warn('facebook inbox listener tick failed', {
        reason: safeFailure(error),
      }),
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
