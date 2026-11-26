import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
const { sealData } = createRequire(resolve('apps/web/package.json'))(
  'iron-session',
);
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const enabled = process.env.RUN_DB_TESTS === '1';
const user = randomUUID(),
  account = randomUUID();
const companies: string[] = [],
  campaigns: string[] = [],
  extraAccounts: string[] = [];
const secret = 'isolated-http-test-secret-with-at-least-32-characters';
let db: typeof import('@sonar/db');
let email: typeof import('@sonar/db/email');
let tasks: typeof import('@sonar/db/tasks');
let admin: import('pg-boss').PgBoss;
let server: ChildProcess | undefined,
  scratch: string,
  origin: string,
  cookie: string;
let settings: { key: string; value: unknown }[] = [];
const settingKeys = [
  'send.hours',
  'send.time_zones',
  'send.whatsapp.min_gap_seconds',
  'send.whatsapp.max_gap_seconds',
  'budget.monthly_usd',
];

beforeAll(async () => {
  if (!enabled) return;
  db = await import('@sonar/db');
  email = await import('@sonar/db/email');
  tasks = await import('@sonar/db/tasks');
  const { PgBoss } = await import('pg-boss');
  admin = new PgBoss(process.env.DATABASE_URL!);
  await admin.start();
  for (const name of [
    'message.send',
    'ai.inbound',
    'form.reply.match',
    'ai.reply',
    'whatsapp.identity.repair',
  ])
    await admin.createQueue(name);
  const { repairWhatsAppConversation } =
    await import('../../../apps/worker/src/inbound');
  await tasks.boss.start();
  await tasks.runTask('whatsapp.identity.repair', async (payload) => {
    const input = payload as {
      conversationId: string;
      userId: string;
      dryRun: boolean;
    };
    const {
      rows: [contact],
    } = await db.sonarPool.query(
      'select ct.normalized from conversations v join contacts ct on ct.id=v.contact_id where v.id=$1',
      [input.conversationId],
    );
    return repairWhatsAppConversation(input, {
      phoneByLid: async () => contact.normalized,
    });
  });
  await db.sonarPool.query(
    "insert into users(id,email,name,password_hash) values($1,$2,'HTTP identity test','stub')",
    [user, `${user}@example.invalid`],
  );
  await db.sonarPool.query(
    "insert into channel_accounts(id,channel,name,address,owner_id,daily_limit,settings) values($1,'whatsapp','HTTP identity test','+12025550001',$2,100,'{\"session\":\"default\"}')",
    [account, user],
  );
  settings = (
    await db.sonarPool.query(
      'select key,value from settings where key=any($1::text[])',
      [settingKeys],
    )
  ).rows;
  for (const [key, value] of [
    ['send.hours', { start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] }],
    ['send.time_zones', { US: 'UTC' }],
    ['send.whatsapp.min_gap_seconds', 0],
    ['send.whatsapp.max_gap_seconds', 0],
    ['budget.monthly_usd', 100],
  ])
    await db.sonarPool.query(
      'insert into settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value',
      [key, JSON.stringify(value)],
    );

  // Run the real Next middleware, session and HTTP route in a private copy/cache.
  scratch = await mkdtemp(join(tmpdir(), 'sonar-wa-p1-http-'));
  const web = join(scratch, 'apps/web');
  await cp(resolve('apps/web'), web, {
    recursive: true,
    filter: (path) =>
      !path
        .split(sep)
        .some(
          (part) =>
            part === 'node_modules' ||
            part === '.next' ||
            part.startsWith('.env') ||
            part.endsWith('.tsbuildinfo'),
        ),
  });
  await cp(resolve('tsconfig.json'), join(scratch, 'tsconfig.json'));
  await symlink(resolve('node_modules'), join(scratch, 'node_modules'), 'dir');
  await symlink(
    resolve('apps/web/node_modules'),
    join(web, 'node_modules'),
    'dir',
  );
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  origin = `http://127.0.0.1:${port}`;
  const require = createRequire(resolve('apps/web/package.json'));
  server = spawn(
    process.execPath,
    [
      require.resolve('next/dist/bin/next'),
      'dev',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd: web,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'development',
        NEXT_TELEMETRY_DISABLED: '1',
        ...(process.env.WATCHPACK_POLLING !== undefined
          ? { WATCHPACK_POLLING: process.env.WATCHPACK_POLLING }
          : {}),
        DATABASE_URL: process.env.DATABASE_URL,
        REGISTRY_DATABASE_URL: process.env.REGISTRY_DATABASE_URL,
        AUTH_SECRET: secret,
        APP_URL: origin,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Next startup timed out: ${output}`)),
      20000,
    );
    const receive = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('Ready in')) {
        clearTimeout(timeout);
        resolve();
      }
    };
    server!.stdout!.on('data', receive);
    server!.stderr!.on('data', receive);
    server!.once('error', reject);
    server!.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Next exited (${code}): ${output}`));
    });
  });
  cookie = `sonar-session=${await sealData({ user: { id: user, name: 'HTTP identity test' } }, { password: secret, ttl: 604800 })}`;
}, 30000);

async function http(id: string, body?: object, expectedStatus?: number) {
  const response = await fetch(`${origin}/api/conversations/${id}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Cookie: cookie,
      Origin: origin,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  expect(response.status, JSON.stringify(data)).toBe(
    expectedStatus ??
      (body &&
      ('dryRun' in body || ('action' in body && body.action === 'generate'))
        ? 202
        : 200),
  );
  return data;
}
async function fixture() {
  const company = randomUUID(),
    campaign = randomUUID(),
    contact = randomUUID(),
    old = randomUUID(),
    later = randomUUID();
  companies.push(company);
  campaigns.push(campaign);
  const phone = `+1202555${String(100 + companies.length).padStart(4, '0')}`,
    lid = `whatsapp:lid:881234567890${companies.length}`;
  await db.sonarPool.query(
    "insert into companies(id,place_id,name,country_code) values($1,$2,'HTTP identity company','US')",
    [company, `manual:${company}`],
  );
  await db.sonarPool.query(
    "insert into campaigns(id,name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights,status,send_mode) values($1,'HTTP paused campaign','US','en','{}','{}','',1,'{\"whatsapp\":true}','{}','paused','auto')",
    [campaign],
  );
  await db.sonarPool.query(
    "insert into contacts(id,company_id,kind,value,normalized,source) values($1,$2,'phone',$3,$3,'manual')",
    [contact, company, phone],
  );
  await db.sonarPool.query(
    "insert into conversations(id,company_id,contact_id,account_id,peer_value,channel,created_at) values($1,$2,$3,$4,$5,'whatsapp','2026-01-01')",
    [old, company, contact, account, lid],
  );
  await db.sonarPool.query(
    "insert into conversations(id,company_id,campaign_id,contact_id,channel,created_at) values($1,$2,$3,$4,'whatsapp','2026-02-01')",
    [later, company, campaign, contact],
  );
  const { rows } = await db.sonarPool.query(
    "insert into messages(conversation_id,account_id,channel,direction,source,to_value,subject,body,status,idempotency_key) values($1,$3,'whatsapp','in','inbound',$4,'','old inbound','delivered',$6),($2,$3,'whatsapp','out','outreach',$5,'','queued outreach','queued',$7) returning id,direction",
    [old, later, account, lid, phone, randomUUID(), randomUUID()],
  );
  return {
    company,
    campaign,
    contact,
    old,
    later,
    phone,
    lid,
    messageId: rows.find((row) => row.direction === 'out').id as string,
    incomingId: rows.find((row) => row.direction === 'in').id as string,
  };
}
async function repair(id: string, dryRun: boolean, expectedStatus = 'done') {
  const { taskId } = await http(id, {
    action: 'repair-whatsapp-identity',
    requestId: randomUUID(),
    dryRun,
  });
  await expect
    .poll(
      async () =>
        (
          await db.sonarPool.query('select status from tasks where id=$1', [
            taskId,
          ])
        ).rows[0].status,
      { timeout: 15000, interval: 50 },
    )
    .toMatch(/done|skipped|failed/);
  const {
    rows: [task],
  } = await db.sonarPool.query(
    'select status,result,reason_code from tasks where id=$1',
    [taskId],
  );
  expect(task.status, JSON.stringify(task)).toBe(expectedStatus);
  return task.result as { conversationId: string; mergedIds: string[] };
}
it.skipIf(!enabled)(
  'HTTP repair preserves a paused campaign and never calls the send stub before or after merge',
  async () => {
    const f = await fixture(),
      stub = vi.fn(async () => 'stub-only-never-provider');
    const send = () =>
      email.sendEmailMessage(
        f.messageId,
        randomUUID(),
        stub,
        new Date('2026-11-16T12:00:00Z'),
        () => 0,
        'whatsapp',
      );
    const before = await send();
    const history = (
      await db.sonarPool.query(
        'select * from messages where conversation_id=any($1::uuid[]) order by id',
        [[f.old, f.later]],
      )
    ).rows;
    const preview = await repair(f.old, true);
    expect(preview.conversationId).toBe(f.old);
    expect(
      (
        await db.sonarPool.query(
          'select campaign_id from conversations where id=$1',
          [f.old],
        )
      ).rows[0].campaign_id,
    ).toBeNull();
    const repaired = await repair(f.old, false),
      after = await send();
    console.log(
      'P1_CAMPAIGN_HTTP',
      JSON.stringify({ before, after, stubCalls: stub.mock.calls.length }),
    );
    expect(before).toMatchObject({
      status: 'paused',
      reasonCode: 'campaign_inactive',
    });
    expect(after).toMatchObject({
      status: 'paused',
      reasonCode: 'campaign_inactive',
    });
    expect(stub).not.toHaveBeenCalled();
    expect((await http(f.later)).conversation).toMatchObject({
      id: repaired.conversationId,
      campaignName: 'HTTP paused campaign',
    });
    expect(
      (
        await db.sonarPool.query(
          'select campaign_id from conversations where id=$1',
          [f.old],
        )
      ).rows[0].campaign_id,
    ).toBe(f.campaign);
    const moved = (
      await db.sonarPool.query(
        'select * from messages where conversation_id=$1 order by id',
        [repaired.conversationId],
      )
    ).rows;
    expect(moved).toEqual(
      history.map((row) => ({
        ...row,
        conversation_id: repaired.conversationId,
      })),
    );
  },
  30000,
);

it.skipIf(!enabled)(
  'HTTP repair refuses conflicting campaigns without relaxing the original send guard or changing history',
  async () => {
    const f = await fixture(),
      otherCampaign = randomUUID(),
      otherThread = randomUUID();
    campaigns.push(otherCampaign);
    await db.sonarPool.query(
      "insert into campaigns(id,name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights,status) values($1,'Other active campaign','US','en','{}','{}','',1,'{\"whatsapp\":true}','{}','active')",
      [otherCampaign],
    );
    await db.sonarPool.query(
      "insert into conversations(id,company_id,campaign_id,contact_id,channel) values($1,$2,$3,$4,'whatsapp')",
      [otherThread, f.company, otherCampaign, f.contact],
    );
    await db.sonarPool.query(
      "insert into messages(conversation_id,account_id,channel,to_value,subject,body,status,idempotency_key) values($1,$2,'whatsapp',$3,'','Other campaign history','draft',$4)",
      [otherThread, account, f.phone, randomUUID()],
    );
    const before = (
      await db.sonarPool.query(
        'select id,campaign_id,merged_into_id from conversations where company_id=$1 order by id',
        [f.company],
      )
    ).rows;
    const history = (
      await db.sonarPool.query(
        'select * from messages where conversation_id=any($1::uuid[]) order by id',
        [before.map((row) => row.id)],
      )
    ).rows;
    const result = await repair(f.old, false, 'skipped');
    expect(result.mergedIds).toEqual([]);
    expect(
      (
        await db.sonarPool.query(
          'select id,campaign_id,merged_into_id from conversations where company_id=$1 order by id',
          [f.company],
        )
      ).rows,
    ).toEqual(before);
    const stub = vi.fn(async () => 'never-provider');
    expect(
      await email.sendEmailMessage(
        f.messageId,
        randomUUID(),
        stub,
        new Date('2026-11-16T12:00:00Z'),
        () => 0,
        'whatsapp',
      ),
    ).toMatchObject({ status: 'paused', reasonCode: 'campaign_inactive' });
    expect(stub).not.toHaveBeenCalled();
    expect(
      (
        await db.sonarPool.query(
          'select * from messages where conversation_id=any($1::uuid[]) order by id',
          [before.map((row) => row.id)],
        )
      ).rows,
    ).toEqual(history);
  },
  30000,
);

async function replyCounts(conversationId: string) {
  const {
    rows: [counts],
  } = await db.sonarPool.query(
    `select
    (select count(*)::int from messages where conversation_id=$1 and source='reply') as messages,
    (select count(*)::int from tasks t join messages m on m.id::text=t.payload->>'messageId' where t.type='message.send' and m.conversation_id=$1 and m.source='reply') as tasks,
    (select count(*)::int from pgboss.job j join tasks t on t.id::text=j.data->>'taskId' join messages m on m.id::text=t.payload->>'messageId' where j.name='message.send' and m.conversation_id=$1 and m.source='reply') as jobs`,
    [conversationId],
  );
  return counts as { messages: number; tasks: number; jobs: number };
}
it.skipIf(!enabled)(
  'HTTP old and canonical URLs share one reply intent across sequential and concurrent retries',
  async () => {
    const f = await fixture(),
      { conversationId } = await repair(f.old, false);
    const body = {
      action: 'reply',
      subject: '',
      body: 'One intended reply',
      requestId: randomUUID(),
    };
    const first = await http(f.later, body);
    const retries = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        http(index % 2 ? f.later : conversationId, body),
      ),
    );
    const counts = await replyCounts(conversationId);
    console.log(
      'P1_REPLY_HTTP',
      JSON.stringify({
        same: retries.every((reply) => reply.id === first.id),
        ...counts,
      }),
    );
    expect(retries.every((reply) => reply.id === first.id)).toBe(true);
    expect(counts).toEqual({ messages: 1, tasks: 1, jobs: 1 });
    await http(
      conversationId,
      { ...body, body: 'Different intent using the same key' },
      400,
    );
    expect(await replyCounts(conversationId)).toEqual(counts);
  },
  30000,
);
it.skipIf(!enabled)(
  'HTTP retries after a merge retain a reply created under a formerly canonical URL',
  async () => {
    const f = await fixture();
    const body = {
      action: 'reply',
      subject: '',
      body: 'Intent created before repair',
      requestId: randomUUID(),
    };
    const first = await http(f.later, body);
    const { conversationId } = await repair(f.old, false);
    const replies = await Promise.all([
      http(f.later, body),
      http(conversationId, body),
    ]);
    const counts = await replyCounts(conversationId);
    console.log(
      'P1_REPLY_PREMERGE_HTTP',
      JSON.stringify({
        same: replies.every((reply) => reply.id === first.id),
        ...counts,
      }),
    );
    expect(replies.every((reply) => reply.id === first.id)).toBe(true);
    expect(counts).toEqual({ messages: 1, tasks: 1, jobs: 1 });
  },
  30000,
);

it.skipIf(!enabled)(
  'HTTP requests waiting on an in-progress repair derive one key after the merge commits',
  async () => {
    const f = await fixture(),
      client = await db.sonarPool.connect();
    const { whatsappConversation } = await import('./whatsapp-identity.js');
    let pending: Promise<{ id: string }>[] = [];
    try {
      await client.query('begin');
      await whatsappConversation(client, account, f.lid, f.phone);
      const body = {
        action: 'reply',
        subject: '',
        body: 'Intent waiting on repair',
        requestId: randomUUID(),
      };
      pending = [http(f.later, body), http(f.old, body)];
      await expect
        .poll(
          async () =>
            (
              await db.sonarPool.query(
                "select count(*)::int n from pg_locks where locktype='advisory' and not granted",
              )
            ).rows[0].n,
          { timeout: 10000, interval: 50 },
        )
        .toBeGreaterThanOrEqual(2);
      await client.query('commit');
      const [first, second] = await Promise.all(pending);
      expect(first!.id).toBe(second!.id);
      expect(await replyCounts(f.old)).toEqual({
        messages: 1,
        tasks: 1,
        jobs: 1,
      });
    } finally {
      await client.query('rollback');
      client.release();
      await Promise.allSettled(pending);
    }
  },
  30000,
);

async function aiCounts(ids: string[]) {
  const {
    rows: [counts],
  } = await db.sonarPool.query(
    `select
    (select count(*)::int from tasks where type='ai.reply' and payload->>'conversationId'=any($1::text[])) as tasks,
    (select count(*)::int from pgboss.job j join tasks t on t.id::text=j.data->>'taskId' where j.name='ai.reply' and t.payload->>'conversationId'=any($1::text[])) as jobs`,
    [ids],
  );
  return counts as { tasks: number; jobs: number };
}
it.skipIf(!enabled)(
  'HTTP read on an old URL waits for merge and marks the moved displayed boundary only',
  async () => {
    const f = await fixture(),
      client = await db.sonarPool.connect();
    const { whatsappConversation } = await import('./whatsapp-identity.js');
    await db.sonarPool.query(
      "update conversations set created_at='2025-12-01' where id=$1",
      [f.later],
    );
    const {
      rows: [laterMessage],
    } = await db.sonarPool.query(
      "insert into messages(conversation_id,account_id,channel,direction,source,to_value,subject,body,status,idempotency_key,created_at) values($1,$2,'whatsapp','in','inbound',$3,'','Later unread message','delivered',$4,now()+interval '1 day') returning id",
      [f.old, account, f.lid, randomUUID()],
    );
    let pending: Promise<unknown> | undefined;
    try {
      await client.query('begin');
      const merged = await whatsappConversation(
        client,
        account,
        f.lid,
        f.phone,
      );
      expect(merged.conversation!.id).toBe(f.later);
      pending = http(f.old, {
        action: 'read',
        messageId: f.incomingId,
        visibleMessageIds: [f.incomingId],
      });
      await expect
        .poll(
          async () =>
            (
              await db.sonarPool.query(
                "select count(*)::int n from pg_stat_activity where wait_event_type='Lock' and pid<>pg_backend_pid()",
              )
            ).rows[0].n,
          { timeout: 10000, interval: 50 },
        )
        .toBeGreaterThanOrEqual(1);
      await client.query('commit');
      await pending;
      const {
        rows: [state],
      } = await db.sonarPool.query(
        'select conversation_id,read_at from messages where id=$1',
        [f.incomingId],
      );
      console.log(
        'ROUND2_READ_HTTP',
        JSON.stringify({
          canonical: state.conversation_id === f.later,
          read: state.read_at !== null,
        }),
      );
      expect(state).toMatchObject({
        conversation_id: f.later,
        read_at: expect.any(Date),
      });
      expect(
        (
          await db.sonarPool.query('select read_at from messages where id=$1', [
            laterMessage.id,
          ])
        ).rows[0].read_at,
      ).toBeNull();
    } finally {
      await client.query('rollback');
      client.release();
      await Promise.allSettled(pending ? [pending] : []);
    }
  },
  30000,
);
it.skipIf(!enabled)(
  'HTTP generate uses one canonical intent for sequential and concurrent alias retries',
  async () => {
    const f = await fixture(),
      { conversationId } = await repair(f.old, false);
    const body = { action: 'generate', requestId: randomUUID() };
    const first = await http(f.later, body);
    const retries = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        http(i % 2 ? f.later : conversationId, body),
      ),
    );
    const counts = await aiCounts([f.old, f.later]);
    console.log(
      'ROUND2_GENERATE_HTTP',
      JSON.stringify({
        same: retries.every((result) => result.id === first.id),
        ...counts,
      }),
    );
    expect(
      retries.every(
        (result) => result.id === first.id && result.created === false,
      ),
    ).toBe(true);
    expect(counts).toEqual({ tasks: 1, jobs: 1 });
  },
  30000,
);
it.skipIf(!enabled)(
  'HTTP generate preserves legacy task keys and polls the same task through either URL after merge',
  async () => {
    const f = await fixture(),
      body = { action: 'generate', requestId: randomUUID() };
    const first = await http(f.later, body);
    const { conversationId } = await repair(f.old, false);
    const retries = await Promise.all([
      http(f.later, body),
      http(conversationId, body),
    ]);
    expect(retries.every((result) => result.id === first.id)).toBe(true);
    expect(await aiCounts([f.old, f.later])).toEqual({ tasks: 1, jobs: 1 });
    for (const id of [f.later, conversationId])
      expect((await http(`${id}?taskId=${first.id}`)).id).toBe(first.id);
    const foreign = await fixture();
    await http(`${foreign.old}?taskId=${first.id}`, undefined, 404);
  },
  30000,
);
it.skipIf(!enabled)(
  'HTTP generate canonicalizes only after an in-progress merge commits',
  async () => {
    const f = await fixture(),
      client = await db.sonarPool.connect();
    const { whatsappConversation } = await import('./whatsapp-identity.js');
    let pending: Promise<{ id: string }>[] = [];
    try {
      await client.query('begin');
      await whatsappConversation(client, account, f.lid, f.phone);
      const body = { action: 'generate', requestId: randomUUID() };
      pending = [http(f.later, body), http(f.old, body)];
      let finished = false;
      const completed = Promise.allSettled(pending).then(() => {
        finished = true;
      });
      const waiting = async () =>
        (
          await db.sonarPool.query(
            "select count(*)::int n from pg_locks where locktype='advisory' and not granted",
          )
        ).rows[0].n as number;
      await expect
        .poll(async () => (await waiting()) >= 2 || finished, {
          timeout: 10000,
          interval: 50,
        })
        .toBe(true);
      const blocked = (await waiting()) >= 2;
      await client.query('commit');
      const [first, second] = await Promise.all(pending);
      await completed;
      const counts = await aiCounts([f.old, f.later]);
      console.log(
        'ROUND2_GENERATE_MERGE_HTTP',
        JSON.stringify({ blocked, same: first!.id === second!.id, ...counts }),
      );
      expect(blocked).toBe(true);
      expect(first!.id).toBe(second!.id);
      expect(counts).toEqual({ tasks: 1, jobs: 1 });
    } finally {
      await client.query('rollback');
      client.release();
      await Promise.allSettled(pending);
    }
  },
  30000,
);

it
  .skipIf(!enabled)
  .each(['save', 'send', 'approve', 'skip', 'manual'] as const)(
  'HTTP %s waits for merge, then applies canonical message scope and campaign/channel guards',
  async (action) => {
    const f = await fixture(),
      client = await db.sonarPool.connect();
    const { whatsappConversation } = await import('./whatsapp-identity.js');
    await db.sonarPool.query('update messages set status=$2 where id=$1', [
      f.messageId,
      action === 'approve' ? 'awaiting_approval' : 'draft',
    ]);
    let pending: Promise<unknown> | undefined;
    try {
      await client.query('begin');
      await whatsappConversation(client, account, f.lid, f.phone);
      pending = http(
        f.later,
        {
          action,
          messageId: f.messageId,
          subject: '',
          body: 'Edited after repair',
        },
        ['save', 'skip'].includes(action) ? 200 : 400,
      );
      await expect
        .poll(
          async () =>
            (
              await db.sonarPool.query(
                "select count(*)::int n from pg_stat_activity where wait_event_type='Lock' and query like '%channel-account:%'",
              )
            ).rows[0].n,
          { timeout: 10000, interval: 50 },
        )
        .toBeGreaterThanOrEqual(1);
      await client.query('commit');
      await pending;
      const {
        rows: [message],
      } = await db.sonarPool.query(
        'select m.body,m.status,m.conversation_id,v.campaign_id from messages m join conversations v on v.id=m.conversation_id where m.id=$1',
        [f.messageId],
      );
      expect(message).toMatchObject({
        conversation_id: f.old,
        campaign_id: f.campaign,
      });
      if (action === 'save')
        expect(message).toMatchObject({
          body: 'Edited after repair',
          status: 'draft',
        });
      if (action === 'skip') expect(message.status).toBe('skipped');
      expect(
        (
          await db.sonarPool.query(
            "select count(*)::int n from tasks where type='message.send' and payload->>'messageId'=$1",
            [f.messageId],
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await client.query('rollback');
      client.release();
      await Promise.allSettled(pending ? [pending] : []);
    }
  },
  30000,
);
it.skipIf(!enabled)(
  'HTTP alias mutations preserve DNC and reject foreign conversation task/message scope',
  async () => {
    const f = await fixture(),
      other = await fixture();
    await repair(f.old, false);
    const outreach = await import('@sonar/db/outreach');
    const before = (
      await db.sonarPool.query('select body from messages where id=$1', [
        f.messageId,
      ])
    ).rows[0].body;
    await expect(
      outreach.editOutreachDraft(
        f.messageId,
        { body: 'Foreign edit' },
        user,
        undefined,
        other.old,
      ),
    ).rejects.toThrow('не належить');
    expect(
      (
        await db.sonarPool.query('select body from messages where id=$1', [
          f.messageId,
        ])
      ).rows[0].body,
    ).toBe(before);
    await http(`${randomUUID()}?taskId=${randomUUID()}`, undefined, 404);
    await email.blockCompany(f.company, user);
    await http(f.later, { action: 'generate', requestId: randomUUID() }, 400);
    await http(
      f.later,
      {
        action: 'reply',
        requestId: randomUUID(),
        subject: '',
        body: 'Blocked reply',
      },
      400,
    );
    for (const action of ['save', 'send', 'approve', 'skip', 'manual'])
      await http(
        f.later,
        { action, messageId: f.messageId, subject: '', body: 'Blocked edit' },
        400,
      );
    expect(await aiCounts([f.old, f.later])).toEqual({ tasks: 0, jobs: 0 });
    await http(f.later, {
      action: 'read',
      messageId: f.incomingId,
      visibleMessageIds: [f.incomingId],
    });
    expect(
      (
        await db.sonarPool.query('select read_at from messages where id=$1', [
          f.incomingId,
        ])
      ).rows[0].read_at,
    ).toEqual(expect.any(Date));
  },
  30000,
);

it.skipIf(!enabled)(
  'HTTP legacy generate intent keeps its campaign cap after its URL becomes an alias',
  async () => {
    const f = await fixture(),
      body = { action: 'generate', requestId: randomUUID() };
    await db.sonarPool.query(
      "update conversations set created_at='2025-12-01' where id=$1",
      [f.later],
    );
    await db.sonarPool.query(
      'update campaigns set budget_usd=0.0001 where id=$1',
      [f.campaign],
    );
    const first = await http(f.old, body);
    const before = (
      await db.sonarPool.query(
        'select id,idempotency_key,payload from tasks where id=$1',
        [first.id],
      )
    ).rows[0];
    const { conversationId } = await repair(f.old, false);
    expect((await http(conversationId, body)).id).toBe(first.id);
    expect(
      (
        await db.sonarPool.query(
          'select id,idempotency_key,payload from tasks where id=$1',
          [first.id],
        )
      ).rows[0],
    ).toEqual(before);
    const { runBudgetedRequest } = await import('@sonar/db/budget');
    const stub = vi.fn(async () => ({
      id: 'stub-only',
      model: 'stub',
      text: 'draft',
      costUsd: 0.0006,
      units: 1,
    }));
    let blocked = false;
    try {
      await runBudgetedRequest('openrouter', 0.0006, first.id, stub);
    } catch (error) {
      expect(error).toMatchObject({ scope: 'campaign' });
      blocked = true;
    }
    console.log(
      'ROUND2_LEGACY_CAMPAIGN',
      JSON.stringify({ blocked, stubCalls: stub.mock.calls.length }),
    );
    expect(blocked).toBe(true);
    expect(stub).not.toHaveBeenCalled();
    expect(await aiCounts([f.old, f.later])).toEqual({ tasks: 1, jobs: 1 });
  },
  30000,
);

async function generatedLockFixture(
  channel: 'email' | 'telegram' | 'form' | 'social',
) {
  const company = randomUUID(),
    campaign = randomUUID(),
    contact = randomUUID(),
    conversation = randomUUID(),
    outgoing = randomUUID(),
    incoming = randomUUID();
  companies.push(company);
  campaigns.push(campaign);
  const address =
    channel === 'email'
      ? `${company}@example.invalid`
      : channel === 'telegram'
        ? '@round3_test'
        : channel === 'form'
          ? 'https://example.invalid/contact'
          : 'https://www.instagram.com/round3_test/';
  await db.sonarPool.query(
    "insert into companies(id,place_id,name,country_code) values($1,$2,'Round3 lock order','US')",
    [company, `manual:${company}`],
  );
  await db.sonarPool.query(
    "insert into campaigns(id,name,country_code,language_code,cities,queries,offer,budget_usd,channels,scoring_weights,status,send_mode) values($1,'Round3 lock order','US','en','{}','{}','',1,$2,'{}','active','manual')",
    [
      campaign,
      JSON.stringify({ [channel === 'form' ? 'forms' : channel]: true }),
    ],
  );
  await db.sonarPool.query(
    'insert into campaign_companies(company_id,campaign_id) values($1,$2)',
    [company, campaign],
  );
  await db.sonarPool.query(
    "insert into contacts(id,company_id,kind,value,normalized,source) values($1,$2,$3,$4,$4,'manual')",
    [contact, company, channel, address],
  );
  await db.sonarPool.query(
    'insert into conversations(id,company_id,campaign_id,contact_id,channel) values($1,$2,$3,$4,$5)',
    [conversation, company, campaign, contact, channel],
  );
  await db.sonarPool.query(
    "insert into messages(id,conversation_id,channel,direction,source,to_value,subject,body,status,idempotency_key) values($1,$3,$4,'out','generated',$5,'Original','Original','draft',$6),($2,$3,$4,'in','inbound',$5,'Incoming','Incoming','delivered',$7)",
    [
      outgoing,
      incoming,
      conversation,
      channel,
      address,
      randomUUID(),
      randomUUID(),
    ],
  );
  return { company, campaign, contact, conversation, outgoing, incoming };
}
it.skipIf(!enabled).each(
  (['email', 'telegram', 'form', 'social'] as const).flatMap((channel) =>
    (['edit', 'read', 'generate', 'reply'] as const).map((action) => ({
      channel,
      action,
    })),
  ),
)(
  'company-first generated $channel draft overlaps $action without a lock cycle or API error',
  async ({ channel, action }) => {
    const f = await generatedLockFixture(channel),
      outreach = await import('@sonar/db/outreach');
    const rawConnect = db.sonarPool.connect.bind(db.sonarPool),
      client = await rawConnect();
    const rawQuery = client.query.bind(client),
      rawRelease = client.release.bind(client);
    client.release = (error?: Error | boolean) => {
      client.query = rawQuery;
      client.release = rawRelease;
      rawRelease(error);
    };
    let ready!: () => void, resume!: () => void;
    const companyHeld = new Promise<void>((resolve) => {
        ready = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
    let held = false;
    client.query = (async (sql: string, values?: unknown[]) => {
      const result = await rawQuery(sql, values);
      if (
        !held &&
        sql.includes('pg_advisory_xact_lock') &&
        sql.includes('company-contact:') &&
        values?.[0] === f.company
      ) {
        held = true;
        // Make the generated writer the deterministic deadlock victim in the RED run.
        await rawQuery("set local deadlock_timeout='100ms'");
        ready();
        await gate;
      }
      return result;
    }) as typeof client.query;
    db.sonarPool.connect = (async () => client) as typeof db.sonarPool.connect;
    const generated = outreach
      .saveOutreachDraft(
        {
          companyId: f.company,
          campaignId: f.campaign,
          contactId: f.contact,
          analysisId: randomUUID(),
          version: 'round3',
        },
        { subject: 'Generated', body: 'Generated' },
        randomUUID(),
      )
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({
          ok: false as const,
          code: (error as { code?: string }).code,
          message: (error as Error).message,
        }),
      );
    db.sonarPool.connect = rawConnect;
    let mutation: Promise<{ status: number }> | undefined;
    try {
      await Promise.race([
        companyHeld,
        generated.then((result) => {
          if (!held)
            throw new Error(
              `Generated writer did not reach the company lock: ${JSON.stringify(result)}`,
            );
        }),
      ]);
      const body =
        action === 'edit'
          ? {
              action: 'save',
              messageId: f.outgoing,
              subject: 'Edited',
              body: 'Edited',
            }
          : action === 'read'
            ? {
                action: 'read',
                messageId: f.incoming,
                visibleMessageIds: [f.incoming],
              }
            : action === 'generate'
              ? { action: 'generate', requestId: randomUUID() }
              : {
                  action: 'reply',
                  requestId: randomUUID(),
                  subject: 'Reply',
                  body: 'Reply',
                  socialDelivery: 'manual',
                };
      mutation = fetch(`${origin}/api/conversations/${f.conversation}`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: origin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }).then((response) => ({ status: response.status }));
      await expect
        .poll(
          async () =>
            (
              await db.sonarPool.query(
                "select count(*)::int n from pg_stat_activity where wait_event_type='Lock' and query like '%company-contact:%'",
              )
            ).rows[0].n,
          { timeout: 10000, interval: 50 },
        )
        .toBeGreaterThanOrEqual(1);
      resume();
      const [draft, response] = await Promise.all([generated, mutation]);
      console.log(
        'ROUND3_LOCK_ORDER',
        JSON.stringify({
          channel,
          action,
          generated: draft.ok,
          ...(!draft.ok ? { code: draft.code } : {}),
          http: response.status,
        }),
      );
      expect(draft).toMatchObject({ ok: true });
      expect(response.status).toBe(action === 'generate' ? 202 : 200);
      const {
        rows: [counts],
      } = await db.sonarPool.query(
        'select count(*)::int n from messages where conversation_id=$1 and body=$2',
        [f.conversation, 'Generated'],
      );
      expect(counts.n).toBe(1);
      if (action === 'edit')
        expect(
          (
            await db.sonarPool.query('select body from messages where id=$1', [
              f.outgoing,
            ])
          ).rows[0].body,
        ).toBe('Edited');
      if (action === 'read')
        expect(
          (
            await db.sonarPool.query(
              'select read_at from messages where id=$1',
              [f.incoming],
            )
          ).rows[0].read_at,
        ).toEqual(expect.any(Date));
    } finally {
      resume();
      await Promise.allSettled([generated, ...(mutation ? [mutation] : [])]);
      client.query = rawQuery;
      db.sonarPool.connect = rawConnect;
    }
  },
  30000,
);

it.skipIf(!enabled)(
  'social inbox metadata and HTTP draft editing do not invert message/conversation locks',
  async () => {
    const f = await generatedLockFixture('social'),
      socialAccount = randomUUID(),
      external = randomUUID(),
      thread = randomUUID();
    extraAccounts.push(socialAccount);
    await db.sonarPool.query(
      "insert into channel_accounts(id,channel,name,address,owner_id,daily_limit) values($1,'instagram','Round3 inbox metadata','round3_owner',$2,100)",
      [socialAccount, user],
    );
    await db.sonarPool.query(
      'update messages set account_id=$2,external_message_id=$3,social_meta=\'{"network":"instagram"}\' where id=$1',
      [f.outgoing, socialAccount, external],
    );
    const inbox = await import('@sonar/db/social-inbox'),
      rawConnect = db.sonarPool.connect.bind(db.sonarPool),
      client = await rawConnect();
    const rawQuery = client.query.bind(client),
      rawRelease = client.release.bind(client);
    client.release = (error?: Error | boolean) => {
      client.query = rawQuery;
      client.release = rawRelease;
      rawRelease(error);
    };
    let ready!: () => void, resume!: () => void;
    const messageHeld = new Promise<void>((resolve) => {
        ready = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
    let held = false;
    client.query = (async (sql: string, values?: unknown[]) => {
      const result = await rawQuery(sql, values);
      if (
        !held &&
        sql.startsWith('update messages set') &&
        sql.includes('social_meta=coalesce')
      ) {
        held = true;
        await rawQuery("set local deadlock_timeout='100ms'");
        ready();
        await gate;
      }
      return result;
    }) as typeof client.query;
    db.sonarPool.connect = (async () => client) as typeof db.sonarPool.connect;
    const persisted = inbox
      .persistSocialInboxBatch(socialAccount, 'instagram', {
        resumeAnchor: null,
        messages: [
          {
            externalMessageId: external,
            threadId: thread,
            direction: 'out',
            senderProfile: 'https://www.instagram.com/round3_owner/',
            peerProfile: 'https://www.instagram.com/round3_test/',
            body: 'Original',
            occurredAt: '2026-11-15T10:00:00Z',
            observedAt: '2026-11-15T10:01:00Z',
          },
        ],
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({
          ok: false as const,
          code: (error as { code?: string }).code,
        }),
      );
    db.sonarPool.connect = rawConnect;
    let mutation: Promise<{ status: number }> | undefined;
    try {
      await Promise.race([
        messageHeld,
        persisted.then((result) => {
          if (!held) throw new Error(JSON.stringify(result));
        }),
      ]);
      mutation = fetch(`${origin}/api/conversations/${f.conversation}`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: origin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'save',
          messageId: f.outgoing,
          subject: 'Edited',
          body: 'Edited',
        }),
      }).then((response) => ({ status: response.status }));
      await expect
        .poll(
          async () =>
            (
              await db.sonarPool.query(
                "select count(*)::int n from pg_stat_activity where wait_event_type='Lock' and pid<>pg_backend_pid()",
              )
            ).rows[0].n,
          { timeout: 10000, interval: 50 },
        )
        .toBeGreaterThanOrEqual(1);
      resume();
      const [result, response] = await Promise.all([persisted, mutation]);
      console.log(
        'ROUND3_SOCIAL_METADATA',
        JSON.stringify({
          persisted: result.ok,
          ...(!result.ok ? { code: result.code } : {}),
          http: response.status,
        }),
      );
      expect(result).toMatchObject({ ok: true });
      expect(response.status).toBe(200);
      expect(
        (
          await db.sonarPool.query(
            'select provider_thread_id from conversations where id=$1',
            [f.conversation],
          )
        ).rows[0].provider_thread_id,
      ).toBe(thread);
      expect(
        (
          await db.sonarPool.query('select body from messages where id=$1', [
            f.outgoing,
          ])
        ).rows[0].body,
      ).toBe('Edited');
    } finally {
      resume();
      await Promise.allSettled([persisted, ...(mutation ? [mutation] : [])]);
      client.query = rawQuery;
      db.sonarPool.connect = rawConnect;
    }
  },
  30000,
);
it.skipIf(!enabled)(
  'concurrent unknown email replies still serialize one request without a company ID',
  async () => {
    const f = await generatedLockFixture('email');
    await db.sonarPool.query(
      'update conversations set company_id=null where id=$1',
      [f.conversation],
    );
    try {
      const body = {
        action: 'reply',
        requestId: randomUUID(),
        subject: 'Reply',
        body: 'One unknown reply',
      };
      const replies = await Promise.all(
        Array.from({ length: 6 }, () => http(f.conversation, body)),
      );
      expect(new Set(replies.map((reply) => reply.id)).size).toBe(1);
      expect(await replyCounts(f.conversation)).toEqual({
        messages: 1,
        tasks: 1,
        jobs: 1,
      });
    } finally {
      await db.sonarPool.query(
        'update conversations set company_id=$2 where id=$1',
        [f.conversation, f.company],
      );
    }
  },
  30000,
);

it
  .skipIf(!enabled)
  .each(['bound', 'identity-conflict', 'occupied-thread'] as const)(
  'inbox %s thread locks its conversation before prior message refresh and later inserts during HTTP read',
  async (mode) => {
    const f = await generatedLockFixture('social'),
      socialAccount = randomUUID(),
      external = randomUUID(),
      addedExternal = randomUUID(),
      thread = randomUUID();
    const peer = 'https://www.instagram.com/round3_test/';
    extraAccounts.push(socialAccount);
    await db.sonarPool.query(
      "insert into channel_accounts(id,channel,name,address,owner_id,daily_limit) values($1,'instagram','Round4 bound inbox','round4_owner',$2,100)",
      [socialAccount, user],
    );
    await db.sonarPool.query(
      'update conversations set account_id=$2,provider_thread_id=$3,peer_value=$4 where id=$1',
      [
        f.conversation,
        socialAccount,
        mode === 'occupied-thread' ? null : thread,
        peer,
      ],
    );
    await db.sonarPool.query(
      'update messages set account_id=$2 where conversation_id=$1',
      [f.conversation, socialAccount],
    );
    await db.sonarPool.query(
      'update messages set external_message_id=$2,social_meta=$3 where id=$1',
      [
        f.incoming,
        external,
        {
          network: 'instagram',
          ...(mode === 'occupied-thread'
            ? {}
            : {
                threadId:
                  mode === 'identity-conflict' ? 'different-thread' : thread,
                peerProfile: peer,
              }),
        },
      ],
    );
    let targetId = f.conversation;
    if (mode === 'occupied-thread') {
      targetId = randomUUID();
      await db.sonarPool.query(
        "insert into conversations(id,channel,account_id,provider_thread_id,peer_value,company_id,campaign_id,contact_id) values($1,'social',$2,$3,$4,$5,$6,$7)",
        [
          targetId,
          socialAccount,
          thread,
          peer,
          f.company,
          f.campaign,
          f.contact,
        ],
      );
    }
    const firstTime = (
      await db.sonarPool.query('select created_at from messages where id=$1', [
        f.incoming,
      ])
    ).rows[0].created_at as Date;
    const observation = (id: string, body: string, time: Date) => ({
      externalMessageId: id,
      threadId: thread,
      direction: 'in' as const,
      senderProfile: peer,
      peerProfile: peer,
      body,
      occurredAt: time.toISOString(),
      observedAt: time.toISOString(),
    });
    const batch = {
      resumeAnchor: null,
      messages: [
        observation(external, 'Incoming', firstTime),
        observation(
          addedExternal,
          'New incoming after visible boundary',
          new Date(firstTime.getTime() + 1000),
        ),
      ],
    };
    const inbox = await import('@sonar/db/social-inbox'),
      rawConnect = db.sonarPool.connect.bind(db.sonarPool),
      client = await rawConnect();
    const rawQuery = client.query.bind(client),
      rawRelease = client.release.bind(client);
    client.release = (error?: Error | boolean) => {
      client.query = rawQuery;
      client.release = rawRelease;
      rawRelease(error);
    };
    let ready!: () => void,
      resume!: () => void,
      held = false;
    const messageHeld = new Promise<void>((resolve) => {
        ready = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
    client.query = (async (sql: string, values?: unknown[]) => {
      const result = await rawQuery(sql, values);
      if (
        !held &&
        ((sql.startsWith('update messages set') &&
          sql.includes('social_meta=coalesce')) ||
          sql.startsWith('update messages set needs_human'))
      ) {
        held = true;
        await rawQuery("set local deadlock_timeout='100ms'");
        ready();
        await gate;
      }
      return result;
    }) as typeof client.query;
    db.sonarPool.connect = (async () => client) as typeof db.sonarPool.connect;
    const persisted = inbox
      .persistSocialInboxBatch(socialAccount, 'instagram', batch)
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({
          ok: false as const,
          code: (error as { code?: string }).code,
        }),
      );
    db.sonarPool.connect = rawConnect;
    let read: Promise<{ status: number }> | undefined;
    try {
      await Promise.race([
        messageHeld,
        persisted.then((result) => {
          if (!held) throw new Error(JSON.stringify(result));
        }),
      ]);
      read = fetch(`${origin}/api/conversations/${f.conversation}`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: origin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'read',
          messageId: f.incoming,
          visibleMessageIds: [f.incoming],
        }),
      }).then((response) => ({ status: response.status }));
      await expect
        .poll(
          async () =>
            (
              await db.sonarPool.query(
                "select count(*)::int n from pg_stat_activity where wait_event_type='Lock' and pid<>pg_backend_pid()",
              )
            ).rows[0].n,
          { timeout: 10000, interval: 50 },
        )
        .toBeGreaterThanOrEqual(1);
      resume();
      const [result, response] = await Promise.all([persisted, read]);
      console.log(
        'ROUND4_BOUND_READ_HTTP',
        JSON.stringify({
          mode,
          persisted: result.ok,
          ...(!result.ok ? { code: result.code } : {}),
          http: response.status,
        }),
      );
      expect(result).toMatchObject({ ok: true });
      expect(response.status).toBe(200);
      if (!result.ok) throw new Error('Inbox persistence failed');
      expect(result.value.created).toBe(1);
      expect(result.value.conflicts).toEqual(
        mode === 'identity-conflict' ? [f.incoming] : [],
      );
      const {
        rows: [prior],
      } = await db.sonarPool.query(
        'select read_at,social_meta,external_message_id from messages where id=$1',
        [f.incoming],
      );
      expect(prior.read_at).toEqual(expect.any(Date));
      expect(prior.external_message_id).toBe(external);
      if (mode === 'identity-conflict')
        expect(prior.social_meta.threadId).toBe('different-thread');
      const {
        rows: [added],
      } = await db.sonarPool.query(
        'select id,conversation_id,account_id,read_at from messages where external_message_id=$1',
        [addedExternal],
      );
      expect(added).toMatchObject({
        conversation_id: targetId,
        account_id: socialAccount,
        read_at: null,
      });
      expect(
        (
          await db.sonarPool.query(
            'select provider_thread_id from conversations where id=$1',
            [f.conversation],
          )
        ).rows[0].provider_thread_id,
      ).toBe(mode === 'occupied-thread' ? null : thread);
      expect(
        (await inbox.persistSocialInboxBatch(socialAccount, 'instagram', batch))
          .created,
      ).toBe(0);
      expect(
        (
          await db.sonarPool.query(
            "select count(*)::int n from tasks where type='ai.inbound' and payload->>'messageId'=$1",
            [added.id],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      resume();
      await Promise.allSettled([persisted, ...(read ? [read] : [])]);
      client.query = rawQuery;
      db.sonarPool.connect = rawConnect;
    }
  },
  30000,
);

it.skipIf(!enabled)(
  'integration HTTP alias scope and ExpectedDraft both survive a concurrent merge and stale saves cannot queue a send',
  async () => {
    const f = await fixture(),
      client = await db.sonarPool.connect();
    const { whatsappConversation } = await import('./whatsapp-identity.js');
    const expected = { subject: '', body: 'queued outreach' };
    await db.sonarPool.query("update messages set status='draft' where id=$1", [
      f.messageId,
    ]);
    let pending: Promise<{ status: number; body: string }>[] = [];
    try {
      await client.query('begin');
      await whatsappConversation(client, account, f.lid, f.phone);
      pending = [f.old, f.later].map((id, i) =>
        fetch(`${origin}/api/conversations/${id}`, {
          method: 'POST',
          headers: {
            Cookie: cookie,
            Origin: origin,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action: 'save',
            messageId: f.messageId,
            subject: '',
            body: `Reviewed edit ${i}`,
            expected,
          }),
        }).then(async (r) => ({ status: r.status, body: await r.text() })),
      );
      await expect
        .poll(
          async () =>
            (
              await db.sonarPool.query(
                "select count(*)::int n from pg_stat_activity where wait_event_type='Lock' and query like '%channel-account:%'",
              )
            ).rows[0].n,
          { timeout: 10000, interval: 50 },
        )
        .toBeGreaterThanOrEqual(1);
      await client.query('commit');
      const results = await Promise.all(pending);
      expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
      const current = (
        await db.sonarPool.query(
          'select subject,body from messages where id=$1',
          [f.messageId],
        )
      ).rows[0];
      await http(f.later, {
        action: 'save',
        messageId: f.messageId,
        ...current,
        expected,
      }); // lost response replay
      await http(
        f.old,
        { action: 'send', messageId: f.messageId, expected },
        400,
      );
      await db.sonarPool.query(
        "update campaigns set status='active' where id=$1",
        [f.campaign],
      );
      const [sent, replayed] = await Promise.all(
        [f.old, f.later].map((id) =>
          http(id, {
            action: 'send',
            messageId: f.messageId,
            expected: current,
          }),
        ),
      );
      expect(sent).toEqual(replayed);
      expect(
        (
          await db.sonarPool.query(
            "select count(*)::int n from tasks where type='message.send' and payload->>'messageId'=$1",
            [f.messageId],
          )
        ).rows[0].n,
      ).toBe(1);
      const foreign = await fixture();
      const outreach = await import('@sonar/db/outreach');
      await expect(
        outreach.editOutreachDraft(
          f.messageId,
          current,
          user,
          current,
          foreign.old,
        ),
      ).rejects.toThrow('не належить');
      console.log(
        'INTEGRATION_EXPECTED_CANONICAL_HTTP',
        JSON.stringify({
          statuses: results.map((r) => r.status),
          sendJobs: 1,
          foreignScopeRejected: true,
        }),
      );
    } finally {
      await client.query('rollback');
      client.release();
      await Promise.allSettled(pending);
    }
  },
  30000,
);

it.skipIf(!enabled)(
  'integration Facebook import → legacy AI draft receipt → concurrent import/snapshot HTTP read keeps account, order and unseen messages',
  async () => {
    const company = randomUUID(),
      receiving = randomUUID(),
      peer = 'https://www.facebook.com/profile.php?id=100000000000091',
      thread = '900000000000091';
    companies.push(company);
    extraAccounts.push(receiving);
    await db.sonarPool.query(
      "insert into companies(id,place_id,name,country_code) values($1,$1::uuid::text,'Integration Facebook','US')",
      [company],
    );
    await db.sonarPool.query(
      "insert into channel_accounts(id,channel,name,address,status,daily_limit,settings) values($1,'facebook','Integration Facebook','','active',20,'{\"sessionStatus\":\"valid\"}')",
      [receiving],
    );
    await db.sonarPool.query(
      "insert into contacts(company_id,kind,value,normalized,source) values($1,'social',$2,$2,'manual')",
      [company, peer],
    );
    const message = (id: string, providerOrder: number) => ({
      externalMessageId: id,
      threadId: thread,
      direction: 'in' as const,
      senderProfile: peer,
      peerProfile: peer,
      body: id,
      occurredAt: null,
      providerTimestamp: '01:08',
      observedAt: '2026-11-15T03:00:00.000Z',
      providerOrder,
    });
    const inbox = await import('@sonar/db/social-inbox'),
      inbound = await import('@sonar/db/inbound');
    const save = (messages: ReturnType<typeof message>[]) =>
      inbox.persistSocialInboxBatch(receiving, 'facebook', {
        messages,
        resumeAnchor: null,
      });
    await save([message('B', 1)]);
    const v = (
      await db.sonarPool.query(
        'select id from conversations where account_id=$1',
        [receiving],
      )
    ).rows[0].id;
    const displayed = await http(v),
      incoming = displayed.messages
        .filter((m: { direction: string }) => m.direction === 'in')
        .map((m: { id: string }) => m.id);
    const draft = await inbound.saveReplyDraft(
      v,
      { body: 'AI stub draft' },
      randomUUID(),
    );
    // Simulate the proven pre-integration draft format. Import must require its audit receipt.
    await db.sonarPool.query(
      'update messages set account_id=null,social_meta=null where id=$1',
      [draft.id],
    );
    const rawConnect = db.sonarPool.connect.bind(db.sonarPool),
      client = await rawConnect(),
      rawQuery = client.query.bind(client),
      rawRelease = client.release.bind(client);
    let ready!: () => void,
      resume!: () => void,
      held = false;
    const arrived = new Promise<void>((r) => {
        ready = r;
      }),
      gate = new Promise<void>((r) => {
        resume = r;
      });
    client.release = (error?: Error | boolean) => {
      client.query = rawQuery;
      client.release = rawRelease;
      rawRelease(error);
    };
    client.query = (async (sql: string, values?: unknown[]) => {
      const result = await rawQuery(sql, values);
      if (
        !held &&
        sql.startsWith('update messages set') &&
        sql.includes('social_meta=coalesce')
      ) {
        held = true;
        ready();
        await gate;
      }
      return result;
    }) as typeof client.query;
    db.sonarPool.connect = (async () => client) as typeof db.sonarPool.connect;
    const imported = save([message('A', 0), message('B', 1), message('C', 2)]);
    db.sonarPool.connect = rawConnect;
    let read: Promise<unknown> | undefined;
    try {
      await arrived;
      read = http(v, {
        action: 'read',
        messageId: incoming[0],
        visibleMessageIds: incoming,
      });
      await expect
        .poll(
          async () =>
            (
              await db.sonarPool.query(
                "select count(*)::int n from pg_stat_activity where wait_event_type='Lock' and query like 'select * from conversations%'",
              )
            ).rows[0].n,
          { timeout: 10000, interval: 50 },
        )
        .toBeGreaterThanOrEqual(1);
      resume();
      expect(await imported).toMatchObject({ created: 2 });
      await read;
      const history = await inbound.getConversationHistory(v),
        chat = await http(v),
        outreach = await import('@sonar/db/outreach'),
        companyHistory = await outreach.getCompanyChat(company);
      const incomingState = (
        rows: { direction: string; body: string; readAt: unknown }[],
      ) =>
        rows
          .filter((m) => m.direction === 'in')
          .map((m) => [m.body, !!m.readAt]);
      const expected = [
        ['A', false],
        ['B', true],
        ['C', false],
      ];
      expect(incomingState(chat.messages)).toEqual(expected);
      expect(incomingState(history.messages)).toEqual(expected);
      expect(incomingState(companyHistory.messages)).toEqual(expected);
      const snapshots = (
        await db.sonarPool.query(
          'select account_id,to_value,direction,social_meta from messages where conversation_id=$1',
          [v],
        )
      ).rows;
      expect(
        snapshots.every(
          (m) =>
            m.account_id === receiving &&
            m.to_value === peer &&
            (m.direction === 'out' || m.social_meta.network === 'facebook'),
        ),
      ).toBe(true);
      expect(
        (await save([message('A', 0), message('B', 1), message('C', 2)]))
          .created,
      ).toBe(0);
      expect(
        (
          await db.sonarPool.query(
            "select count(*)::int n from tasks where type='ai.inbound' and payload->>'messageId' in(select id::text from messages where conversation_id=$1 and direction='in')",
            [v],
          )
        ).rows[0].n,
      ).toBe(3);
      console.log(
        'INTEGRATION_FACEBOOK_SNAPSHOT_HTTP',
        JSON.stringify({
          http: 200,
          order: expected,
          receivingAccount: true,
          aiInbound: 3,
        }),
      );
    } finally {
      resume();
      await Promise.allSettled([imported, ...(read ? [read] : [])]);
      client.query = rawQuery;
      db.sonarPool.connect = rawConnect;
    }
  },
  30000,
);

it.skipIf(!enabled)(
  'integration merge waits for a stubbed in-flight WhatsApp send and preserves its committed durable request',
  async () => {
    const f = await fixture();
    await db.sonarPool.query(
      "update campaigns set status='active' where id=$1",
      [f.campaign],
    );
    let ready!: () => void, resume!: () => void;
    const entered = new Promise<void>((r) => {
        ready = r;
      }),
      gate = new Promise<void>((r) => {
        resume = r;
      });
    const stub = vi.fn(async () => {
      ready();
      await gate;
      return 'synthetic-integration-delivery';
    });
    const send = () =>
      email.sendEmailMessage(
        f.messageId,
        randomUUID(),
        stub,
        new Date('2026-11-16T12:00:00Z'),
        () => 0,
        'whatsapp',
      );
    const sending = send();
    let repairing: Promise<unknown> | undefined;
    try {
      await Promise.race([
        entered,
        sending.then((result) => {
          throw Error(JSON.stringify(result));
        }),
      ]);
      const before = (
        await db.sonarPool.query('select * from messages where id=$1', [
          f.messageId,
        ])
      ).rows[0];
      repairing = repair(f.old, false);
      await expect
        .poll(
          async () =>
            (
              await db.sonarPool.query(
                "select count(*)::int n from pg_stat_activity where wait_event_type='Lock' and query like '%channel-account:%'",
              )
            ).rows[0].n,
          { timeout: 10000, interval: 50 },
        )
        .toBeGreaterThanOrEqual(1);
      expect(
        (
          await db.sonarPool.query(
            'select merged_into_id from conversations where id=$1',
            [f.later],
          )
        ).rows[0].merged_into_id,
      ).toBeNull();
      resume();
      expect(await sending).toMatchObject({ status: 'done' });
      await repairing;
      const after = (
        await db.sonarPool.query('select * from messages where id=$1', [
          f.messageId,
        ])
      ).rows[0];
      expect(after).toMatchObject({
        id: before.id,
        conversation_id: f.old,
        status: 'sent',
        account_id: before.account_id,
        first_attempt_at: before.first_attempt_at,
        request_snapshot: before.request_snapshot,
        idempotency_key: before.idempotency_key,
        to_value: before.to_value,
        body: before.body,
      });
      expect(await send()).toMatchObject({ status: 'done' });
      expect(stub).toHaveBeenCalledTimes(1);
      console.log(
        'INTEGRATION_MERGE_SEND',
        JSON.stringify({
          send: 'done',
          repaired: true,
          stubCalls: 1,
          durableRequestPreserved: true,
        }),
      );
    } finally {
      resume();
      await Promise.allSettled([sending, ...(repairing ? [repairing] : [])]);
    }
  },
  30000,
);

afterAll(async () => {
  if (!enabled) return;
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await once(server, 'exit');
  }
  if (scratch) {
    await rm(scratch, { recursive: true, force: true });
  }
  if (!db) return;
  await tasks.closeTaskQueue();
  const ids = (
    await db.sonarPool.query(
      'select id from conversations where company_id=any($1::uuid[])',
      [companies],
    )
  ).rows.map((row) => row.id);
  await db.sonarPool.query(
    "delete from spend_events where task_id in(select id from tasks where payload->>'conversationId'=any($1::text[]))",
    [ids],
  );
  await db.sonarPool.query(
    "delete from tasks where payload->>'conversationId'=any($1::text[]) or payload->>'messageId' in(select id::text from messages where conversation_id=any($2::uuid[]))",
    [ids, ids],
  );
  await db.sonarPool.query(
    'delete from messages where conversation_id=any($1::uuid[])',
    [ids],
  );
  await db.sonarPool.query(
    'update conversations set merged_into_id=null where id=any($1::uuid[])',
    [ids],
  );
  await db.sonarPool.query(
    'delete from conversations where id=any($1::uuid[])',
    [ids],
  );
  await db.sonarPool.query(
    'delete from contacts where company_id=any($1::uuid[])',
    [companies],
  );
  await db.sonarPool.query(
    'delete from campaign_companies where company_id=any($1::uuid[])',
    [companies],
  );
  await db.sonarPool.query('delete from campaigns where id=any($1::uuid[])', [
    campaigns,
  ]);
  await db.sonarPool.query(
    'delete from do_not_contact where company_id=any($1::uuid[])',
    [companies],
  );
  await db.sonarPool.query('delete from companies where id=any($1::uuid[])', [
    companies,
  ]);
  await db.sonarPool.query(
    'delete from channel_accounts where id=any($1::uuid[])',
    [[account, ...extraAccounts]],
  );
  await db.sonarPool.query(
    'delete from activity_log where user_id=$1 or entity_id=any($2::text[])',
    [user, [...ids, ...companies]],
  );
  await db.sonarPool.query('delete from users where id=$1', [user]);
  await db.sonarPool.query('delete from settings where key=any($1::text[])', [
    settingKeys,
  ]);
  for (const setting of settings)
    await db.sonarPool.query('insert into settings(key,value) values($1,$2)', [
      setting.key,
      JSON.stringify(setting.value),
    ]);
  await admin?.stop();
  await db.sonarPool.end();
  await db.registryPool.end();
}, 30000);
