import { sendEmailMessage, type ChannelSender } from '@sonar/db/email';
import { recordInbound } from '@sonar/db/inbound';
import { sonarPool } from '@sonar/db';
import { boss, enqueueTask, runTask, type TaskOutcome } from '@sonar/db/tasks';

type ViberInbound = {
  from: string;
  text: string;
  at: string;
  providerMessageId: string;
  threadId?: string;
};

export class ViberBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ViberBridgeError';
  }
}

async function bridge(path: string, init?: RequestInit) {
  const base = process.env.VIBER_BRIDGE_URL;
  const key = process.env.VIBER_BRIDGE_KEY;
  if (!base || !key)
    throw new ViberBridgeError('Viber Desktop не налаштовано.');
  const response = await fetch(new URL(path, base), {
    ...init,
    headers: { Authorization: `Bearer ${key}`, ...init?.headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new ViberBridgeError(`Viber bridge HTTP ${response.status}`);
  return response;
}

export async function runViberSend(
  input: { messageId: string },
  taskId: string,
  send?: ChannelSender,
  now?: Date,
): Promise<TaskOutcome> {
  if (!send && (!process.env.VIBER_BRIDGE_URL || !process.env.VIBER_BRIDGE_KEY))
    return {
      status: 'paused',
      reasonCode: 'viber_bridge_missing',
      reasonUk: 'Налаштуйте внутрішній міст Viber Desktop.',
    };
  return sendEmailMessage(
    input.messageId,
    taskId,
    send ??
      (async (request) => {
        const response = await bridge('/send', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            to: request.to,
            text: request.body,
            idempotencyKey: request.idempotencyKey,
          }),
        });
        const result = (await response.json()) as {
          state?: string;
          providerMessageId?: string;
          reason?: string;
        };
        if (result.state !== 'sent' || !result.providerMessageId)
          throw new ViberBridgeError(
            result.reason ??
              'Доставку Viber не підтверджено. Перевірте чат вручну; автоматичний повтор заблоковано.',
          );
        return result.providerMessageId;
      }),
    now,
    Math.random,
    'viber',
  );
}

export async function pollViberInbound(now = new Date()): Promise<TaskOutcome> {
  if (!process.env.VIBER_BRIDGE_URL || !process.env.VIBER_BRIDGE_KEY)
    return {
      status: 'skipped',
      reasonCode: 'viber_bridge_missing',
      reasonUk: 'Міст Viber Desktop не налаштовано.',
    };
  const {
    rows: [account],
  } = await sonarPool.query<{ id: string }>(
    "select id from channel_accounts where channel='viber' and status='active' limit 1",
  );
  if (!account)
    return {
      status: 'paused',
      reasonCode: 'viber_account_paused',
      reasonUk: 'Синхронізацію Viber призупинено.',
    };
  const { rows: recentRecipients } = await sonarPool.query<{
    to_value: string;
  }>(
    `select distinct to_value from messages
     where channel='viber' and account_id=$1
       and coalesce(sent_at,created_at)>=now()-interval '14 days'
       and to_value ~ '^\\+[1-9][0-9]{6,14}$'
     order by to_value limit 500`,
    [account.id],
  );
  const { rows: frontiers } = await sonarPool.query<{
    to_value: string;
    after: Date | null;
  }>(
    `select to_value,
       max(case when direction='in' then created_at
                when direction='out' and status in ('sent','delivered','read') then coalesce(sent_at,created_at)
           end) as after
     from messages where channel='viber' and account_id=$1
       and to_value ~ '^\\+[1-9][0-9]{6,14}$'
     group by to_value`,
    [account.id],
  );
  const afterByRecipient = new Map(
    frontiers
      .filter((item): item is { to_value: string; after: Date } => !!item.after)
      .map((item) => [item.to_value, item.after.toISOString()]),
  );
  const inboundUrl = new URL('/inbound', 'http://bridge');
  inboundUrl.searchParams.set(
    'since',
    new Date(now.getTime() - 24 * 60 * 60_000).toISOString(),
  );
  for (const recipient of recentRecipients)
    inboundUrl.searchParams.append('to', recipient.to_value);
  for (const [recipient, after] of afterByRecipient)
    inboundUrl.searchParams.append('after', `${recipient}|${after}`);
  const response = await bridge(`${inboundUrl.pathname}${inboundUrl.search}`);
  const messages = (await response.json()) as ViberInbound[];
  if (!Array.isArray(messages))
    throw new ViberBridgeError('Некоректна відповідь списку Viber.');
  let imported = 0;
  for (const message of messages) {
    const result = await recordInbound({
      channel: 'viber',
      accountId: account.id,
      providerId: message.providerMessageId,
      externalMessageId: message.providerMessageId,
      providerThreadId: message.threadId,
      sender: message.from,
      body: message.text,
      receivedAt: message.at,
    });
    if (result.created) imported++;
  }
  let reconciled = 0;
  try {
    const outgoingUrl = new URL('/outgoing', 'http://bridge');
    outgoingUrl.searchParams.set(
      'since',
      new Date(now.getTime() - 2 * 60_000).toISOString(),
    );
    for (const recipient of recentRecipients)
      outgoingUrl.searchParams.append('to', recipient.to_value);
    const response = await bridge(
      `${outgoingUrl.pathname}${outgoingUrl.search}`,
    );
    const outgoing = (await response.json()) as {
      from: string;
      text: string;
      at: string;
      providerMessageId: string;
    }[];
    if (Array.isArray(outgoing)) {
      const { reconcileViberDeliveries } = await import('@sonar/db/viber');
      reconciled = await reconcileViberDeliveries(outgoing, now);
    }
  } catch {
    // Incoming synchronization remains useful if outbound reconciliation is unavailable.
  }
  return { status: 'done', result: { imported, reconciled } };
}

async function enqueueViberInboxIfDue(now = new Date()) {
  const {
    rows: [setting],
  } = await sonarPool.query<{ value: unknown }>(
    "select value from settings where key='viber.inbox.poll_seconds'",
  );
  const interval = Number(setting?.value);
  if (!Number.isSafeInteger(interval) || interval < 60) return;
  const {
    rows: [last],
  } = await sonarPool.query<{ created_at: Date | null }>(
    "select max(created_at) as created_at from tasks where type='viber.inbox.sync'",
  );
  if (
    last?.created_at &&
    now.getTime() - last.created_at.getTime() < interval * 1000
  )
    return;
  const slot = Math.floor(now.getTime() / (interval * 1000));
  await enqueueTask('viber.inbox.sync', `viber.inbox:${slot}`, {});
}

export async function registerViberTasks() {
  await boss.createQueue('viber.inbox.sync');
  await runTask(
    'viber.inbox.sync',
    () => pollViberInbound(),
    async () => enqueueViberInboxIfDue(),
  );
  await boss.createQueue('viber.inbox.reconcile');
  await boss.work('viber.inbox.reconcile', async () =>
    enqueueViberInboxIfDue(),
  );
  await boss.schedule('viber.inbox.reconcile', '* * * * *');
  await enqueueViberInboxIfDue();
}
