import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { socialTarget } from '@sonar/core';
import { sonarPool } from './index.js';
import { enqueueTask } from './tasks.js';

async function transaction<T>(fn: (client: PoolClient) => Promise<T>) {
  const client = await sonarPool.connect();
  try {
    await client.query('begin');
    const value = await fn(client);
    await client.query('commit');
    return value;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export class FacebookRecipientCheckError extends Error {
  constructor(
    public status: 400 | 403 | 404,
    public reasonUk: string,
  ) {
    super(reasonUk);
  }
}

async function targetForContact(
  client: Pick<PoolClient, 'query'>,
  companyId: string,
  contactId: string,
) {
  const { rows } = await client.query(
    'select value,kind from contacts where id=$1 and company_id=$2',
    [contactId, companyId],
  );
  if (!rows[0])
    throw new FacebookRecipientCheckError(404, 'Контакт не знайдено.');
  const target = rows[0].kind === 'social' ? socialTarget(rows[0].value) : null;
  if (!target || target.network !== 'facebook' || target.kind === 'unsupported')
    throw new FacebookRecipientCheckError(
      400,
      'Перевірка доступна лише для Facebook-контакту.',
    );
  return target;
}

export async function enqueueFacebookRecipientCheck(
  companyId: string,
  contactId: string,
  userId: string,
) {
  return transaction(async (client) => {
    const target = await targetForContact(client, companyId, contactId);
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended('facebook-recipient-check:'||$1::text,0))",
      [contactId],
    );
    const {
      rows: [account],
    } = await client.query(
      "select id from channel_accounts where channel='facebook' and owner_id=$1 order by (status='active' and settings->>'sessionStatus'='valid') desc,created_at desc,id limit 1",
      [userId],
    );
    if (!account)
      throw new FacebookRecipientCheckError(
        403,
        'Перевірити одержувача може лише власник Facebook-акаунта.',
      );
    const {
      rows: [pending],
    } = await client.query(
      "select id,status,result,reason_uk as \"reasonUk\" from tasks where type='social.recipient.check' and payload->>'contactId'=$1 and status in ('queued','running') order by created_at desc limit 1",
      [contactId],
    );
    if (pending) return { ...pending, created: false };
    const id = await enqueueTask(
      'social.recipient.check',
      `social.recipient.check:${contactId}:${randomUUID()}`,
      {
        accountId: account.id,
        companyId,
        contactId,
        target,
      },
      client,
    );
    if (id)
      await client.query(
        "update tasks set subject_type='company',subject_id=$2 where id=$1",
        [id, companyId],
      );
    const {
      rows: [task],
    } = await client.query(
      'select id,status,result,reason_uk as "reasonUk" from tasks where id=$1',
      [id],
    );
    return { ...task, created: true };
  });
}

export async function getFacebookRecipientCheck(
  companyId: string,
  contactId: string,
  userId: string,
) {
  const { rows } = await sonarPool.query(
    `select t.id,t.status,t.result,t.reason_uk as "reasonUk",t.created_at as "createdAt",
      t.payload->>'accountId' as "accountId"
     from tasks t join contacts c on c.id=$2::uuid and c.company_id=$1::uuid
     where t.type='social.recipient.check' and t.payload->>'contactId'=$2::text
       and exists(select 1 from channel_accounts a where a.id::text=t.payload->>'accountId' and a.owner_id=$3::uuid and a.channel='facebook')
     order by t.created_at desc limit 1`,
    [companyId, contactId, userId],
  );
  return rows[0] ?? null;
}

export async function getFacebookRecipientTarget(
  companyId: string,
  contactId: string,
) {
  return targetForContact(sonarPool, companyId, contactId);
}
