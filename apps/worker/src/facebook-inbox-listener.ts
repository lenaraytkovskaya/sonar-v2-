import { resolveSocialSession } from '@sonar/core/social-session';
import { sonarPool } from '@sonar/db';
import { queueSocialInboxWake } from '@sonar/db/social-inbox';
import type { SocialSessionAccount } from '@sonar/db/social-accounts';
import { connectSocialProfile } from './social-profile-browser.js';
import { THREAD_LINKS, watchMessenger } from './facebook-inbox-watch.js';

const TICK_MS = 30000;
const RETRY_MIN_MS = 30000;
const RETRY_MAX_MS = 10 * 60 * 1000;
const BLOCKED_RETRY_MS = 10 * 60 * 1000;

interface Listener {
  stop: boolean;
  done: Promise<void>;
  wakes: number;
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

  async function listen(account: SocialSessionAccount, listener: Listener) {
    const session = resolveSocialSession(account as never);
    const { context } = await connectSocialProfile(account, session as never);
    const page = await context.newPage();
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
        await report(account.id, { state: 'watching', error: null });
        const minGapMs =
          Number(await setting('social.inbox.listen_min_gap_seconds', 15)) *
          1000;
        const end = await watchMessenger(page, {
          minGapMs,
          stopped: () => listener.stop || closed,
          onChange: async () => {
            listener.wakes++;
            const queued = await queueSocialInboxWake(account.id);
            await report(account.id, {
              wakes: listener.wakes,
              lastWakeAt: new Date().toISOString(),
              lastWakeQueued: queued,
            });
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
    for (const [id, listener] of listeners)
      if (!wanted.has(id)) listener.stop = true;
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
