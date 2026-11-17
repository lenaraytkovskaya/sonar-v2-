import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
const enabled = process.env.RUN_DB_TESTS === '1';

it.skipIf(!enabled)(
  'journals deduplicated alarms and pauses only the affected account sends atomically',
  async () => {
    const { sonarPool } = await import('./index.js');
    const { recordHealthEvent } = await import('./account-health.js');
    const c = await sonarPool.connect();
    const account = randomUUID(),
      other = randomUUID(),
      company = randomUUID(),
      conversation = randomUUID(),
      message = randomUUID(),
      task = randomUUID(),
      directTask = randomUUID(),
      otherTask = randomUUID();
    const now = new Date('2026-11-17T12:00:00Z');
    let enqueuedTask: string | null = null;
    try {
      await c.query(
        "insert into channel_accounts(id,channel,name,address,daily_limit,settings) values($1::uuid,'facebook','Health test','',10,'{\"sessionStatus\":\"valid\"}'),($2,'facebook','Other health test','',10,'{\"sessionStatus\":\"valid\"}')",
        [account, other],
      );
      await c.query(
        "insert into companies(id,place_id,name,country_code) values($1::uuid,$1::text,'Health company','UA')",
        [company],
      );
      await c.query(
        "insert into conversations(id,company_id,account_id,channel) values($1::uuid,$2,$3,'social')",
        [conversation, company, account],
      );
      await c.query(
        "insert into messages(id,conversation_id,account_id,channel,to_value,subject,body,status,idempotency_key) values($1::uuid,$2,$3,'social','peer','','stub','queued',$1::text)",
        [message, conversation, account],
      );
      for (const [id, payload] of [
        [task, { messageId: message }],
        [directTask, { accountId: account }],
        [otherTask, { accountId: other }],
      ] as const)
        await c.query(
          "insert into tasks(id,type,idempotency_key,payload) values($1::uuid,'message.send',$1::text,$2)",
          [id, payload],
        );
      const details = { eventKey: `captcha:${task}` };
      expect(
        await recordHealthEvent(
          c,
          account,
          'captcha',
          'Потрібна капча.',
          details,
          now,
        ),
      ).toBeTruthy();
      expect(
        await recordHealthEvent(
          c,
          account,
          'captcha',
          'Потрібна капча.',
          details,
          new Date(now.getTime() + 3_600_000),
        ),
      ).toBeNull();
      // A related classification from the same operation has a separate journal row.
      expect(
        await recordHealthEvent(
          c,
          account,
          'session_lost',
          'Сесію втрачено.',
          details,
          now,
        ),
      ).toBeTruthy();
      let stored = (
        await c.query(
          'select status,settings from channel_accounts where id=$1',
          [account],
        )
      ).rows[0];
      expect(stored.status).toBe('paused');
      expect(Date.parse(stored.settings.healthPauseUntil)).toBe(
        now.getTime() + 24 * 3_600_000,
      );
      expect(stored.settings.sessionStatus).toBe('valid');
      expect(stored.settings.reasonUk).toContain('Автоматична пауза до');
      const taskRows = (
        await c.query(
          'select id,status,reason_code from tasks where id=any($1::uuid[])',
          [[task, directTask, otherTask]],
        )
      ).rows;
      expect(taskRows.find((row) => row.id === task)).toMatchObject({
        status: 'paused',
        reason_code: 'account_health_paused',
      });
      expect(taskRows.find((row) => row.id === directTask)?.status).toBe(
        'paused',
      );
      expect(taskRows.find((row) => row.id === otherTask)?.status).toBe(
        'queued',
      );
      expect(
        (
          await c.query(
            'select kind,count(*)::int as n from account_health_events where account_id=$1 group by kind',
            [account],
          )
        ).rows,
      ).toEqual(
        expect.arrayContaining([
          { kind: 'captcha', n: 1 },
          { kind: 'session_lost', n: 1 },
          { kind: 'auto_paused', n: 1 },
        ]),
      );
      // A send enqueued during an existing pause must never reach pg-boss.
      const { enqueueTask } = await import('./tasks.js');
      enqueuedTask = await enqueueTask('message.send', `health-new:${task}`, {
        messageId: message,
      });
      expect(enqueuedTask).toBeTruthy();
      expect(
        (
          await c.query('select status,reason_code from tasks where id=$1', [
            enqueuedTask,
          ])
        ).rows[0],
      ).toMatchObject({
        status: 'paused',
        reason_code: 'account_health_paused',
      });
      if (
        (await c.query("select to_regclass('pgboss.job') as relation")).rows[0]
          .relation
      )
        expect(
          (
            await c.query(
              "select count(*)::int as n from pgboss.job where data->>'taskId'=$1",
              [enqueuedTask],
            )
          ).rows[0].n,
        ).toBe(0);
      const repeatAt = new Date(now.getTime() + 86_400_000);
      await recordHealthEvent(
        c,
        account,
        'rate_limited',
        'Ліміт платформи.',
        { eventKey: `rate:${task}` },
        repeatAt,
      );
      stored = (
        await c.query('select settings from channel_accounts where id=$1', [
          account,
        ])
      ).rows[0];
      expect(Date.parse(stored.settings.healthPauseUntil)).toBe(
        repeatAt.getTime() + 48 * 3_600_000,
      );
      // Event and pause participate in the caller's rollback.
      await c.query('begin');
      await recordHealthEvent(
        c,
        other,
        'checkpoint',
        'Перевірка входу.',
        { eventKey: 'rolled-back' },
        now,
      );
      await c.query('rollback');
      expect(
        (
          await c.query(
            'select count(*)::int as n from account_health_events where account_id=$1',
            [other],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await c.query('select status from channel_accounts where id=$1', [
            other,
          ])
        ).rows[0].status,
      ).toBe('active');
    } finally {
      await c.query('rollback');
      await c.query('delete from tasks where id=any($1::uuid[])', [
        [task, directTask, otherTask, enqueuedTask].filter(Boolean),
      ]);
      await c.query('delete from messages where id=$1', [message]);
      await c.query('delete from conversations where id=$1', [conversation]);
      await c.query('delete from channel_accounts where id=any($1::uuid[])', [
        [account, other],
      ]);
      await c.query('delete from companies where id=$1', [company]);
      c.release();
    }
  },
);

it.skipIf(!enabled)(
  'resumes existing send jobs after expiry only for valid sessions, and clears manual pauses immediately',
  async () => {
    const { sonarPool } = await import('./index.js');
    const health = await import('./account-health.js');
    const { PgBoss } = await import('pg-boss');
    const admin = new PgBoss(process.env.DATABASE_URL!);
    await admin.start();
    await admin.createQueue('message.send');
    const c = await sonarPool.connect();
    const valid = randomUUID(),
      invalid = randomUUID(),
      disabled = randomUUID(),
      email = randomUUID(),
      telegramValid = randomUUID(),
      telegramInvalid = randomUUID(),
      telegramMissing = randomUUID(),
      whatsapp = randomUUID(),
      company = randomUUID(),
      conversation = randomUUID(),
      message = randomUUID(),
      task = randomUUID();
    const now = new Date('2026-11-17T12:00:00Z');
    try {
      const fixtures = [
        [
          valid,
          'facebook',
          { sessionStatus: 'valid', enabled: true },
          'active',
        ],
        [
          invalid,
          'facebook',
          { sessionStatus: 'invalid', enabled: true },
          'active',
        ],
        [
          disabled,
          'facebook',
          { sessionStatus: 'valid', enabled: false },
          'disabled',
        ],
        [email, 'email', {}, 'active'],
        [
          telegramValid,
          'telegram',
          { sessionEncrypted: 'encrypted-fixture' },
          'active',
        ],
        [
          telegramInvalid,
          'telegram',
          { sessionEncrypted: 'encrypted-fixture', sessionStatus: 'invalid' },
          'active',
        ],
        [telegramMissing, 'telegram', {}, 'active'],
        [whatsapp, 'whatsapp', { providerStatus: 'STOPPED' }, 'active'],
      ] as const;
      for (const [id, channel, settings, status] of fixtures)
        await c.query(
          "insert into channel_accounts(id,channel,name,address,daily_limit,settings,status) values($1::uuid,$2,'Health expiry','',10,$3,$4)",
          [id, channel, settings, status],
        );
      await c.query(
        "insert into companies(id,place_id,name,country_code) values($1::uuid,$1::text,'Expiry company','UA')",
        [company],
      );
      await c.query(
        "insert into conversations(id,company_id,account_id,channel) values($1::uuid,$2,$3,'social')",
        [conversation, company, valid],
      );
      await c.query(
        "insert into messages(id,conversation_id,account_id,channel,to_value,subject,body,status,idempotency_key) values($1::uuid,$2,$3,'social','peer','','stub','queued',$1::text)",
        [message, conversation, valid],
      );
      await c.query(
        "insert into tasks(id,type,idempotency_key,payload) values($1::uuid,'message.send',$1::text,$2)",
        [task, { messageId: message }],
      );
      for (const [id] of fixtures)
        await health.recordHealthEvent(
          c,
          id,
          'action_blocked',
          'Дію обмежено.',
          { eventKey: `pause:${id}` },
          now,
        );
      await health.reconcileAccountHealthPauses(
        new Date(now.getTime() + 25 * 3_600_000),
      );
      expect(
        (
          await c.query('select status from channel_accounts where id=$1', [
            valid,
          ])
        ).rows[0].status,
      ).toBe('active');
      expect(
        (await c.query('select status from tasks where id=$1', [task])).rows[0]
          .status,
      ).toBe('queued');
      for (const id of [email, telegramValid])
        expect(
          (
            await c.query('select status from channel_accounts where id=$1', [
              id,
            ])
          ).rows[0].status,
        ).toBe('active');
      expect(
        (
          await c.query('select status from channel_accounts where id=$1', [
            disabled,
          ])
        ).rows[0].status,
      ).toBe('disabled');
      for (const id of [invalid, telegramInvalid, telegramMissing, whatsapp])
        expect(
          (
            await c.query('select status from channel_accounts where id=$1', [
              id,
            ])
          ).rows[0].status,
        ).toBe('paused');
      await c.query(
        'update channel_accounts set settings=settings||\'{"providerStatus":"WORKING"}\'::jsonb where id=$1',
        [whatsapp],
      );
      await health.reconcileAccountHealthPauses(
        new Date(now.getTime() + 25 * 3_600_000),
      );
      expect(
        (
          await c.query('select status from channel_accounts where id=$1', [
            whatsapp,
          ])
        ).rows[0].status,
      ).toBe('active');
      // Ordinary enables must not remove an unrelated provider safety pause.
      const ordinaryBefore = (
        await c.query(
          "select count(*)::int as n from account_health_events where account_id=$1 and kind='auto_resumed'",
          [whatsapp],
        )
      ).rows[0].n;
      await c.query(
        'update channel_accounts set status=\'paused\',settings=settings||\'{"reasonUk":"Перевірте доставку вручну."}\'::jsonb where id=$1',
        [whatsapp],
      );
      await c.query('begin');
      await health.enableAccountHealth(c, whatsapp, now);
      await c.query('commit');
      const ordinaryAfter = (
        await c.query(
          'select status,settings from channel_accounts where id=$1',
          [whatsapp],
        )
      ).rows[0];
      expect(ordinaryAfter.status).toBe('paused');
      expect(ordinaryAfter.settings.reasonUk).toBe(
        'Перевірте доставку вручну.',
      );
      expect(
        (
          await c.query(
            "select count(*)::int as n from account_health_events where account_id=$1 and kind='auto_resumed'",
            [whatsapp],
          )
        ).rows[0].n,
      ).toBe(ordinaryBefore);
      const before = (
        await c.query(
          "select count(*)::int as n from account_health_events where account_id=$1 and kind='auto_resumed'",
          [valid],
        )
      ).rows[0].n;
      await health.reconcileAccountHealthPauses(
        new Date(now.getTime() + 26 * 3_600_000),
      );
      expect(
        (
          await c.query(
            "select count(*)::int as n from account_health_events where account_id=$1 and kind='auto_resumed'",
            [valid],
          )
        ).rows[0].n,
      ).toBe(before);
      await c.query('begin');
      await health.enableAccountHealth(c, invalid, now);
      await c.query('commit');
      const manuallyCleared = (
        await c.query(
          'select status,settings from channel_accounts where id=$1',
          [invalid],
        )
      ).rows[0];
      expect(manuallyCleared.settings.healthAutoPaused).toBe(false);
      expect(manuallyCleared.settings.healthPauseUntil).toBeUndefined();
      expect(manuallyCleared.status).toBe('paused');
    } finally {
      await c.query('rollback');
      await c.query('delete from tasks where id=$1', [task]);
      await c.query('delete from messages where id=$1', [message]);
      await c.query('delete from conversations where id=$1', [conversation]);
      await c.query('delete from channel_accounts where id=any($1::uuid[])', [
        [
          valid,
          invalid,
          disabled,
          email,
          telegramValid,
          telegramInvalid,
          telegramMissing,
          whatsapp,
        ],
      ]);
      await c.query('delete from companies where id=$1', [company]);
      c.release();
      await admin.stop();
    }
  },
);

it.skipIf(!enabled)(
  'aggregates zero-filled daily sends, same-account company replies, full alarm history and journal retention',
  async () => {
    const { sonarPool } = await import('./index.js');
    const health = await import('./account-health.js');
    const account = randomUUID(),
      other = randomUUID(),
      company = randomUUID(),
      unsolicited = randomUUID(),
      conversation = randomUUID(),
      otherConversation = randomUUID();
    const ids: string[] = [];
    const now = new Date('2026-11-17T12:00:00Z');
    const addMessage = async (
      thread: string,
      owner: string,
      direction: 'in' | 'out',
      at: string,
      status = 'sent',
    ) => {
      const id = randomUUID();
      ids.push(id);
      await sonarPool.query(
        "insert into messages(id,conversation_id,account_id,direction,channel,to_value,subject,body,status,idempotency_key,sent_at,created_at) values($1::uuid,$2,$3,$4,'email','health@invalid.test','','stub',$5,$1::text,$6,$6)",
        [id, thread, owner, direction, status, at],
      );
    };
    try {
      for (const id of [account, other])
        await sonarPool.query(
          "insert into channel_accounts(id,channel,name,address,daily_limit,created_at) values($1::uuid,'email','Health metrics','health@invalid.test',50,'2026-10-01')",
          [id],
        );
      for (const id of [company, unsolicited])
        await sonarPool.query(
          "insert into companies(id,place_id,name,country_code) values($1::uuid,$1::text,'Health metrics company','UA')",
          [id],
        );
      await sonarPool.query(
        "insert into conversations(id,company_id,account_id,channel) values($1::uuid,$2,$3,'email'),($4,$5,$3,'email')",
        [conversation, company, account, otherConversation, unsolicited],
      );
      await addMessage(conversation, account, 'in', '2026-11-16T08:00:00Z'); // Before outreach.
      await addMessage(conversation, account, 'out', '2026-11-17T09:00:00Z');
      await addMessage(conversation, account, 'out', '2026-11-17T09:01:00Z');
      await addMessage(conversation, account, 'in', '2026-11-17T10:00:00Z');
      await addMessage(conversation, account, 'in', '2026-11-17T10:01:00Z');
      await addMessage(
        otherConversation,
        account,
        'in',
        '2026-11-17T11:00:00Z',
      ); // Unsolicited.
      await addMessage(conversation, other, 'in', '2026-11-17T11:00:00Z'); // Other sender account.
      await addMessage(conversation, account, 'out', '2026-11-01T09:00:00Z'); // Outside the window.
      await sonarPool.query(
        "insert into account_health_events(account_id,kind,reason_uk,created_at) values($1::uuid,'send_failed','Помилка.','2026-11-01T12:00:00Z'),($1,'send_failed','Стара помилка.','2026-01-01T12:00:00Z')",
        [account],
      );
      const summary = (await health.accountHealth(account, now))[0]!;
      expect(summary).toMatchObject({
        accountId: account,
        sentToday: 2,
        sent14Days: 2,
        replies: 1,
        replyRate: 1,
        dailyLimit: 50,
        alarmCount7Days: 0,
        daysWithoutAlarms: 16,
        lastAlarmAt: '2026-11-01T12:00:00.000Z',
      });
      expect(summary.daily).toHaveLength(14);
      expect(summary.daily.at(-1)).toEqual({ date: '2026-11-17', sent: 2 });
      expect(summary.daily.slice(0, -1).every((day) => day.sent === 0)).toBe(
        true,
      );
      expect(summary.events).toHaveLength(1);
      expect(JSON.stringify(summary)).not.toMatch(
        /sessionEncrypted|cookiesEncrypted|settings/,
      );
      await health.cleanupAccountHealthEvents(now);
      expect(
        (
          await sonarPool.query(
            'select count(*)::int as n from account_health_events where account_id=$1',
            [account],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await sonarPool.query('delete from messages where id=any($1::uuid[])', [
        ids,
      ]);
      await sonarPool.query(
        'delete from conversations where id=any($1::uuid[])',
        [[conversation, otherConversation]],
      );
      await sonarPool.query(
        'delete from channel_accounts where id=any($1::uuid[])',
        [[account, other]],
      );
      await sonarPool.query('delete from companies where id=any($1::uuid[])', [
        [company, unsolicited],
      ]);
    }
  },
);

afterAll(async () => {
  if (!enabled) return;
  const { closeTaskQueue } = await import('./tasks.js');
  const { sonarPool, registryPool } = await import('./index.js');
  await closeTaskQueue();
  await Promise.all([sonarPool.end(), registryPool.end()]);
});
