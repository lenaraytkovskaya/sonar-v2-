import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  calculateAccountHealth,
  healthEventKinds,
  pauseHealthKinds,
  type AccountHealthStatus,
  type HealthConfig,
  type HealthEvent,
  type HealthEventKind,
} from '@sonar/core/account-health';
import { sonarPool } from './index.js';
export { isAccountHealthPaused } from '@sonar/core/account-health';
export type { HealthEvent, HealthEventKind } from '@sonar/core/account-health';

type Client = Pick<PoolClient, 'query'>;
async function healthConfig(c: Client): Promise<HealthConfig> {
  const { rows } = await c.query(
    "select jsonb_object_agg(substr(key,8),value) as value from settings where key like 'health.%'",
  );
  const config = rows[0]?.value as HealthConfig | undefined;
  if (
    !config ||
    [
      'pause_hours',
      'repeat_pause_hours',
      'repeat_window_days',
      'retention_days',
      'summary_days',
      'watch_send_failures',
      'watch_relogins',
      'warning_alarms',
    ].some(
      (key) =>
        !Number.isInteger(config[key as keyof HealthConfig]) ||
        config[key as keyof HealthConfig] <= 0,
    )
  )
    throw new Error('Invalid health settings');
  return config;
}

/** One statement commits the event, account pause and queued send pauses together.
 * The common account lock is reentrant for callers already holding it. */
export async function recordHealthEvent(
  c: PoolClient,
  accountId: string,
  kind: HealthEventKind,
  reasonUk: string,
  details: Record<string, unknown> = {},
  now = new Date(),
): Promise<string | null> {
  if (!healthEventKinds.includes(kind) || !reasonUk.trim())
    throw new Error('Invalid account health event');
  const eventId = randomUUID();
  const { rows } = await c.query(
    `with guard as materialized (
      select pg_advisory_xact_lock(hashtextextended('channel-account:'||$1::text,0))
    ), account as materialized (
      select a.* from channel_accounts a cross join guard where a.id=$1::uuid for update of a
    ), config as materialized (select jsonb_object_agg(substr(key,8),value) as value from settings where key like 'health.%'),
    event as (
      insert into account_health_events(id,account_id,kind,reason_uk,details,created_at)
      select $7::uuid,id,$2,$3,$4::jsonb,$6::timestamptz from account
      on conflict do nothing returning id
    ), pause_plan as materialized (
      select account.id,greatest(coalesce((account.settings->>'healthPauseUntil')::timestamptz,$6::timestamptz),
        $6::timestamptz + make_interval(hours => case
          when (account.settings->>'healthLastAlarmAt')::timestamptz >= $6::timestamptz - make_interval(days => (config.value->>'repeat_window_days')::int)
          then (config.value->>'repeat_pause_hours')::int else (config.value->>'pause_hours')::int end)) as until
      from account,config,event where $2=any($5::text[])
    ), paused as (
      update channel_accounts a set status=case when a.status='disabled' then 'disabled' else 'paused' end,
      settings=a.settings||jsonb_build_object('healthAutoPaused',true,'healthLastAlarmAt',$6::text,
        'healthPauseUntil',p.until,'reasonUk','Автоматична пауза до '||to_char(p.until at time zone 'UTC','DD.MM.YYYY HH24:MI')||' UTC. '||$3::text)
      from pause_plan p where a.id=p.id returning a.id,a.settings
    ), pause_event as (
      insert into account_health_events(account_id,kind,reason_uk,details,created_at)
      select id,'auto_paused',settings->>'reasonUk',jsonb_build_object('eventKey',$7::text||':paused','triggerEventId',$7::text,'pauseUntil',settings->>'healthPauseUntil'),$6::timestamptz from paused
    ), paused_tasks as (
      update tasks t set status='paused',reason_code='account_health_paused',reason_uk=p.settings->>'reasonUk',finished_at=$6::timestamptz
      from paused p where t.status='queued' and t.type='message.send' and (
        t.payload->>'accountId'=p.id::text or exists(
          select 1 from messages m where m.id::text=t.payload->>'messageId' and m.account_id=p.id))
    ) select id from event`,
    [
      accountId,
      kind,
      reasonUk.trim(),
      { ...details, eventKey: details.eventKey ?? eventId },
      pauseHealthKinds,
      now.toISOString(),
      eventId,
    ],
  );
  return rows[0]?.id ?? null;
}

async function resumePausedSends(c: PoolClient, accountId: string) {
  const { rows } = await c.query(
    `select t.idempotency_key,t.payload from tasks t
    join messages m on m.id::text=t.payload->>'messageId'
    where t.type='message.send' and t.status='paused' and t.reason_code='account_health_paused'
    and m.account_id=$1 and m.status='queued' order by t.created_at,t.id`,
    [accountId],
  );
  const { enqueueTask } = await import('./tasks.js');
  for (const task of rows)
    await enqueueTask('message.send', task.idempotency_key, task.payload, c);
}

function sessionCanResume(channel: string, settings: Record<string, unknown>) {
  if (['facebook', 'instagram', 'linkedin'].includes(channel))
    return settings.sessionStatus === 'valid';
  if (channel === 'telegram')
    return (
      typeof settings.sessionEncrypted === 'string' &&
      settings.sessionEncrypted.length > 0 &&
      settings.sessionStatus !== 'invalid'
    );
  if (channel === 'whatsapp') return settings.providerStatus === 'WORKING';
  return channel === 'email';
}

/** Caller owns a transaction, as account edits and resumed queue jobs must commit together. */
export async function enableAccountHealth(
  c: PoolClient,
  accountId: string,
  now = new Date(),
) {
  await c.query(
    "select pg_advisory_xact_lock(hashtextextended('channel-account:'||$1::text,0))",
    [accountId],
  );
  const {
    rows: [account],
  } = await c.query(
    'select channel,settings from channel_accounts where id=$1 for update',
    [accountId],
  );
  if (!account) throw new Error('Акаунт каналу не знайдено.');
  if (account.settings.healthAutoPaused !== true) return;
  const canResume = sessionCanResume(account.channel, account.settings);
  await c.query(
    `update channel_accounts set status=case when $2 then 'active' else 'paused' end,settings=(settings-'healthPauseUntil')||jsonb_build_object('healthAutoPaused',false,'enabled',true,'reasonUk',case when $2 then null else coalesce(settings->>'sessionLostReasonUk','Потрібна перевірка сесії акаунта.') end) where id=$1`,
    [accountId, canResume],
  );
  await recordHealthEvent(
    c,
    accountId,
    'auto_resumed',
    canResume
      ? 'Автоматичну паузу знято вручну.'
      : 'Автоматичну паузу знято вручну. Потрібна перевірка сесії.',
    { eventKey: `enabled:${randomUUID()}`, source: 'manual' },
    now,
  );
  if (canResume) await resumePausedSends(c, accountId);
}

/** Reuses durable task rows and their original dispatch keys; it never creates a second message. */
export async function reconcileAccountHealthPauses(now = new Date()) {
  const c = await sonarPool.connect();
  let resumed = 0;
  try {
    const { rows } = await c.query(
      `select id from channel_accounts where status='paused' and settings->>'healthAutoPaused'='true'
      and (settings->>'healthPauseUntil')::timestamptz <= $1::timestamptz order by id`,
      [now.toISOString()],
    );
    for (const candidate of rows) {
      await c.query('begin');
      try {
        const {
          rows: [lock],
        } = await c.query(
          "select pg_try_advisory_xact_lock(hashtextextended('channel-account:'||$1::text,0)) as locked",
          [candidate.id],
        );
        if (!lock.locked) {
          await c.query('commit');
          continue;
        }
        const {
          rows: [account],
        } = await c.query(
          'select * from channel_accounts where id=$1 for update',
          [candidate.id],
        );
        if (
          account?.status === 'paused' &&
          account.settings.healthAutoPaused === true &&
          account.settings.enabled !== false &&
          Date.parse(account.settings.healthPauseUntil) <= now.getTime() &&
          sessionCanResume(account.channel, account.settings)
        ) {
          await c.query(
            `update channel_accounts set status='active',settings=(settings-'healthPauseUntil')||jsonb_build_object('healthAutoPaused',false,'reasonUk',null) where id=$1`,
            [candidate.id],
          );
          await recordHealthEvent(
            c,
            candidate.id,
            'auto_resumed',
            'Автоматичну паузу завершено: сесію підтверджено.',
            { eventKey: `pause-expired:${account.settings.healthPauseUntil}` },
            now,
          );
          await resumePausedSends(c, candidate.id);
          resumed++;
        }
        await c.query('commit');
      } catch (error) {
        await c.query('rollback');
        throw error;
      }
    }
    return resumed;
  } finally {
    c.release();
  }
}

/** Invoked by the worker's daily maintenance job. */
export async function cleanupAccountHealthEvents(now = new Date()) {
  const config = await healthConfig(sonarPool);
  const result = await sonarPool.query(
    'delete from account_health_events where created_at < $1::timestamptz-make_interval(days=>$2::int)',
    [now.toISOString(), config.retention_days],
  );
  return result.rowCount ?? 0;
}

export type AccountHealthSummary = {
  accountId: string;
  name: string;
  addressMasked: string;
  visible: boolean;
  channel: string;
  status: AccountHealthStatus;
  pauseUntil: string | null;
  sentToday: number;
  dailyLimit: number;
  daily: { date: string; sent: number }[];
  sent14Days: number;
  /** Unique companies that replied after outreach from this account in the summary window. */
  replies: number;
  replyRate: number | null;
  sendFailures: number;
  eventsByKind: Partial<Record<HealthEventKind, number>>;
  alarmCount7Days: number;
  daysWithoutAlarms: number;
  averageSessionHours: number | null;
  lastAlarmAt: string | null;
  events: HealthEvent[];
};

export async function accountHealth(
  accountId: string | 'all' = 'all',
  now = new Date(),
): Promise<AccountHealthSummary[]> {
  const config = await healthConfig(sonarPool);
  const { rows } = await sonarPool.query(
    `with bounds as (select $2::timestamptz as finish,
      (($2::timestamptz at time zone 'UTC')::date-($3::int-1))::timestamp at time zone 'UTC' as start),
    cohort as (select m.account_id,v.company_id,min(m.sent_at) as first_sent from messages m
      join conversations v on v.id=m.conversation_id cross join bounds b
      where m.direction='out' and v.company_id is not null and m.sent_at>=b.start and m.sent_at<=b.finish
      group by m.account_id,v.company_id),
    replied as (select cohort.* from cohort cross join bounds b where exists(
      select 1 from messages m join conversations v on v.id=m.conversation_id
      where coalesce(m.account_id,v.account_id)=cohort.account_id and v.company_id=cohort.company_id
      and m.direction='in' and m.created_at>=cohort.first_sent and m.created_at<=b.finish))
    select a.id,a.name,a.address,a.channel,a.status,a.settings,a.created_at,a.daily_limit,
    (select count(*)::int from messages m,bounds b where m.account_id=a.id and m.direction='out' and m.sent_at>=date_trunc('day',b.finish at time zone 'UTC') at time zone 'UTC' and m.sent_at<=b.finish) as sent_today,
    (select coalesce(jsonb_agg(jsonb_build_object('date',to_char(d,'YYYY-MM-DD'),'sent',
      (select count(*)::int from messages m where m.account_id=a.id and m.direction='out' and m.sent_at>=d at time zone 'UTC' and m.sent_at<(d+interval '1 day') at time zone 'UTC' and m.sent_at<=$2::timestamptz)) order by d),'[]')
      from bounds b,generate_series(b.start at time zone 'UTC',(b.finish at time zone 'UTC')::date::timestamp,interval '1 day') d) as daily,
    (select count(*)::int from messages m,bounds b where m.account_id=a.id and m.direction='out' and m.sent_at>=b.start and m.sent_at<=b.finish) as sent,
    (select count(*)::int from replied where account_id=a.id) as replies,
    (select count(*)::int from cohort where account_id=a.id) as contacted,
    (select count(*)::int from messages m,bounds b where m.account_id=a.id and m.direction='out' and m.status='failed' and m.created_at>=b.start and m.created_at<=b.finish) as failed,
    (select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'kind',e.kind,'reasonUk',e.reason_uk,'details',e.details,'createdAt',e.created_at) order by e.created_at desc,e.id),'[]')
      from account_health_events e where e.account_id=a.id and e.created_at>=$2::timestamptz-make_interval(days=>$4::int) and e.created_at<=$2::timestamptz) as events
    from channel_accounts a where a.channel in ('email','telegram','whatsapp','facebook','instagram','linkedin') and ($1='all' or a.id::text=$1) order by a.channel,a.name,a.id`,
    [accountId, now.toISOString(), config.summary_days, config.retention_days],
  );
  const summaryStart =
    Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) -
    (config.summary_days - 1) * 86_400_000;
  return rows.map((row) => {
      const events = (row.events as HealthEvent[]).map((event) => ({
      ...event,
      createdAt: new Date(event.createdAt).toISOString(),
    }));
    const eventsByKind: Partial<Record<HealthEventKind, number>> = {};
    for (const event of events)
      if (Date.parse(event.createdAt) >= summaryStart)
        eventsByKind[event.kind] = (eventsByKind[event.kind] ?? 0) + 1;
    return {
      accountId: row.id,
      name: row.name,
      addressMasked: row.address
        ? row.address.includes('@')
          ? `${row.address[0]}•••@${row.address.split('@').at(-1)}`
          : `${row.address.slice(0, 3)}${'•'.repeat(Math.max(3, row.address.length - 7))}${row.address.slice(-4)}`
        : '',
      visible:
        !['disabled', 'removed', 'disconnected'].includes(row.status) &&
        row.settings.enabled !== false,
      channel: row.channel,
      ...calculateAccountHealth({
        accountStatus: row.status,
        settings: row.settings,
        createdAt: row.created_at.toISOString(),
        events,
        config,
        now,
      }),
      pauseUntil:
        row.settings.healthAutoPaused === true
          ? (row.settings.healthPauseUntil ?? null)
          : null,
      sentToday: row.sent_today,
      dailyLimit: row.daily_limit,
      daily: row.daily,
      sent14Days: row.sent,
      replies: row.replies,
      replyRate: row.contacted ? row.replies / row.contacted : null,
      sendFailures: Math.max(row.failed, eventsByKind.send_failed ?? 0),
      eventsByKind,
      events: events.slice(0, 30),
    };
  });
}
