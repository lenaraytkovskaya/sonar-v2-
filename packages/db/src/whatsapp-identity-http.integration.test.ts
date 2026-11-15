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
  campaigns: string[] = [];
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
];

beforeAll(async () => {
  if (!enabled) return;
  db = await import('@sonar/db');
  email = await import('@sonar/db/email');
  tasks = await import('@sonar/db/tasks');
  const { PgBoss } = await import('pg-boss');
  admin = new PgBoss(process.env.DATABASE_URL!);
  await admin.start();
  for (const name of ['message.send', 'whatsapp.identity.repair'])
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
    expectedStatus ?? (body && 'dryRun' in body ? 202 : 200),
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
  await db.sonarPool.query('delete from campaigns where id=any($1::uuid[])', [
    campaigns,
  ]);
  await db.sonarPool.query('delete from companies where id=any($1::uuid[])', [
    companies,
  ]);
  await db.sonarPool.query('delete from channel_accounts where id=$1', [
    account,
  ]);
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
