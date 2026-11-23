import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { chatUrl, createSend, scrollWithSettledPointer } from './send.js';
import { readMessages } from './database.js';

const folders: string[] = [];
const temporary = async () => {
  const path = await mkdtemp(join(tmpdir(), 'sonar-viber-test-'));
  folders.push(path);
  return path;
};
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const input = {
  to: '+380671234567',
  text: 'Привіт & + ?\nДругий рядок',
  idempotencyKey: 'send:1',
};
it('keeps the pointer inside until the asynchronous wheel events are processed', async () => {
  let inside = false,
    settled = 0,
    pending = 0,
    applied = 0;
  await scrollWithSettledPointer({
    move: async (value) => {
      inside = value;
      if (!inside) pending = 0;
    },
    scroll: async () => {
      if (inside && settled >= 100) {
        pending = 6;
        settled = 0;
      }
    },
    wait: async (ms) => {
      if (inside) {
        settled += ms;
        if (pending && settled >= 600) {
          applied += pending;
          pending = 0;
        }
      }
    },
  });
  expect(applied).toBe(6);
  expect(inside).toBe(false);
});
it('encodes exact recipient and draft without URL parameter injection', () => {
  const url = new URL(chatUrl(input));
  expect(url.protocol).toBe('viber:');
  expect(url.searchParams.get('number')).toBe('380671234567');
  expect(url.searchParams.get('draft')).toBe(input.text);
  expect(() => chatUrl({ ...input, to: '380671234567&number=1' })).toThrow();
});
it('never dispatches the same durable key twice across bridge restarts', async () => {
  const path = await temporary();
  const open = vi.fn(),
    enter = vi.fn();
  const desktop = {
    open,
    enter,
    screen: async () => Buffer.from('jpeg'),
    wait: async () => {},
    messages: vi.fn().mockResolvedValue([]),
  };
  const first = await createSend(path, desktop)(input);
  expect(first.state).toBe('uncertain');
  expect(await createSend(path, desktop)(input)).toEqual(first);
  expect(open).toHaveBeenCalledTimes(1);
  expect(enter).toHaveBeenCalledTimes(1);
  await expect(
    createSend(path, desktop)({ ...input, text: 'different' }),
  ).rejects.toThrow('idempotency_conflict');
});
it('does not press Enter when recipient verification fails', async () => {
  const enter = vi.fn();
  const result = await createSend(await temporary(), {
    open: async () => {
      throw Error('recipient_not_verified');
    },
    enter,
    screen: async () => Buffer.from('jpeg'),
    wait: async () => {},
    messages: async () => [],
  })(input);
  expect(result.state).toBe('uncertain');
  expect(enter).not.toHaveBeenCalled();
});
it('confirms only a new matching outgoing provider row', async () => {
  const messages = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValue([
      {
        from: input.to,
        text: input.text,
        at: new Date().toISOString(),
        providerMessageId: '7',
        threadId: '4',
        outgoing: true,
      },
    ]);
  const result = await createSend(await temporary(), {
    messages,
    open: async () => {},
    enter: async () => {},
    screen: async () => Buffer.from('jpeg'),
    wait: async () => {},
  })(input);
  expect(result).toEqual({ state: 'sent', providerMessageId: '7' });
});
const screenSlice = (text = '') => ({
  observedAt: new Date(Date.now() + 1000).toISOString(),
  composer: '',
  notes: false,
  bubbles: text
    ? [
        {
          left: 400,
          top: 300,
          right: 600,
          bottom: 360,
          side: 'right' as const,
          text,
          messageTime: new Date().toTimeString().slice(0, 5),
          status: 'sent' as 'sent' | 'pending' | 'failed' | 'unknown',
        },
      ]
    : [],
});
it('confirms a new matching outgoing screen bubble without a database', async () => {
  const path = await temporary();
  const enter = vi.fn();
  const confirm = vi
    .fn()
    .mockImplementation(async (expected?: string) => screenSlice(expected));
  const desktop = {
    messages: vi.fn().mockRejectedValue(Error('encrypted_database')),
    open: vi.fn(),
    enter,
    confirm,
    screen: async () => Buffer.from('synthetic screenshot'),
    wait: async () => {},
  };
  const first = await createSend(path, desktop)(input);
  expect(first.state).toBe('sent');
  expect(first.providerMessageId).toMatch(/^screen:/);
  expect(await createSend(path, desktop)(input)).toEqual(first);
  expect(enter).toHaveBeenCalledTimes(1);
  expect(confirm).toHaveBeenCalledTimes(2);
});
it('uses the baseline returned before the desktop prepares a multiline draft', async () => {
  const confirm = vi
    .fn()
    .mockImplementation(async () => screenSlice(input.text));
  const result = await createSend(await temporary(), {
    messages: async () => [],
    open: async () => screenSlice(),
    enter: vi.fn(),
    confirm,
    wait: async () => {},
    screen: async () => Buffer.from('jpeg'),
  })(input);
  expect(result.state).toBe('sent');
  expect(confirm).toHaveBeenCalledTimes(1);
});
it('keeps checking after a wrong screen bubble when the database is unreadable', async () => {
  const confirm = vi
    .fn()
    .mockResolvedValueOnce(screenSlice())
    .mockResolvedValueOnce(screenSlice('wrong text'))
    .mockResolvedValue(screenSlice(input.text));
  const wait = vi.fn().mockResolvedValue(undefined);
  const result = await createSend(await temporary(), {
    messages: vi.fn().mockRejectedValue(Error('encrypted_database')),
    open: vi.fn(),
    enter: vi.fn(),
    confirm,
    screen: async () => Buffer.from('synthetic screenshot'),
    wait,
  })(input);
  expect(result.state).toBe('sent');
  expect(confirm).toHaveBeenCalledTimes(3);
  expect(wait).toHaveBeenCalledTimes(2);
});
it('does not press Enter when the screen baseline fails', async () => {
  const enter = vi.fn();
  const result = await createSend(await temporary(), {
    messages: async () => [],
    open: vi.fn(),
    enter,
    wait: async () => {},
    screen: async () => Buffer.from('jpeg'),
    confirm: vi.fn().mockRejectedValue(Error('viber_modal_visible')),
  })(input);
  expect(result).toMatchObject({
    state: 'uncertain',
    reason: 'screen_baseline_unavailable',
  });
  expect(enter).not.toHaveBeenCalled();
});
it('continues database verification when post-send OCR throws', async () => {
  const messages = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValue([
      {
        from: input.to,
        text: input.text,
        at: new Date().toISOString(),
        providerMessageId: 'new',
        threadId: '4',
        outgoing: true,
      },
    ]);
  const result = await createSend(await temporary(), {
    messages,
    open: vi.fn(),
    enter: vi.fn(),
    wait: async () => {},
    screen: async () => Buffer.from('jpeg'),
    confirm: vi
      .fn()
      .mockResolvedValueOnce(screenSlice())
      .mockRejectedValue(Error('ocr_failed')),
  })(input);
  expect(result).toEqual({ state: 'sent', providerMessageId: 'new' });
});
it('keeps a post-send modal uncertain even if SQLite would contain a new outgoing row', async () => {
  const messages = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValue([
      {
        from: input.to,
        text: input.text,
        providerMessageId: 'new',
        outgoing: true,
      },
    ]);
  const result = await createSend(await temporary(), {
    messages,
    open: async () => screenSlice(),
    enter: vi.fn(),
    wait: async () => {},
    screen: async () => Buffer.from('jpeg'),
    confirm: vi.fn().mockRejectedValue(Error('viber_modal_visible')),
  })(input);
  expect(result).toMatchObject({
    state: 'uncertain',
    reason: 'viber_modal_visible',
  });
  expect(messages).toHaveBeenCalledTimes(1);
});
it('does not confuse a pre-existing identical bubble or a pending status with a new send', async () => {
  const old = screenSlice(input.text);
  for (const current of [
    old,
    {
      ...old,
      bubbles: [
        ...old.bubbles,
        { ...old.bubbles[0]!, status: 'pending' as const },
      ],
    },
  ]) {
    const result = await createSend(await temporary(), {
      messages: async () => [],
      open: vi.fn(),
      enter: vi.fn(),
      wait: async () => {},
      screen: async () => Buffer.from('jpeg'),
      confirm: vi.fn().mockResolvedValueOnce(old).mockResolvedValue(current),
    })(input);
    expect(result.state).toBe('uncertain');
  }
});
it('does not let a new database row override visible failure or pending status', async () => {
  for (const status of ['failed', 'pending'] as const) {
    const current = screenSlice(input.text);
    current.bubbles[0]!.status = status;
    const messages = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        {
          from: input.to,
          text: input.text,
          at: new Date().toISOString(),
          providerMessageId: 'new',
          threadId: '4',
          outgoing: true,
        },
      ]);
    const result = await createSend(await temporary(), {
      messages,
      open: vi.fn(),
      enter: vi.fn(),
      wait: async () => {},
      screen: async () => Buffer.from('jpeg'),
      confirm: vi
        .fn()
        .mockResolvedValueOnce(screenSlice())
        .mockResolvedValue(current),
    })(input);
    expect(result).toMatchObject({
      state: 'uncertain',
      reason: `outgoing_${status}`,
    });
    expect(messages).toHaveBeenCalledTimes(1);
  }
});
it('waits for a pending bubble to gain sent ticks', async () => {
  const pending = screenSlice(input.text);
  pending.bubbles[0]!.status = 'pending';
  const result = await createSend(await temporary(), {
    messages: async () => [],
    open: vi.fn(),
    enter: vi.fn(),
    wait: async () => {},
    screen: async () => Buffer.from('jpeg'),
    confirm: vi
      .fn()
      .mockResolvedValueOnce(screenSlice())
      .mockResolvedValueOnce(pending)
      .mockResolvedValue(screenSlice(input.text)),
  })(input);
  expect(result.state).toBe('sent');
});
it('keeps an unreadable spatially latest bubble uncertain instead of using an older match or database row', async () => {
  const old = screenSlice(input.text);
  const latest = {
    ...old.bubbles[0]!,
    text: '',
    messageTime: undefined,
    status: 'unknown' as const,
  };
  const messages = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValue([
      {
        from: input.to,
        text: input.text,
        at: new Date().toISOString(),
        providerMessageId: 'new',
        threadId: '4',
        outgoing: true,
      },
    ]);
  const result = await createSend(await temporary(), {
    messages,
    open: vi.fn(),
    enter: vi.fn(),
    wait: async () => {},
    screen: async () => Buffer.from('jpeg'),
    confirm: vi
      .fn()
      .mockResolvedValueOnce(old)
      .mockResolvedValue({ ...old, bubbles: [...old.bubbles, latest] }),
  })(input);
  expect(result).toMatchObject({
    state: 'uncertain',
    reason: 'missing_metadata',
  });
  expect(messages).toHaveBeenCalledTimes(1);
});
it('reads a synthetic Viber SQLite snapshot and leaves the source unchanged', async () => {
  const path = join(await temporary(), 'viber.db');
  const fixture = new DatabaseSync(path);
  fixture.exec(
    `create table Contact(ContactID integer,Number text);
    create table Events(EventID integer,ChatID integer,ContactID integer,TimeStamp integer,Direction integer);
    create table Messages(EventID integer,Body text);
    insert into Contact values(1,'380671234567'),(2,'380638215990');
    insert into Events values(10,2,1,1700000000000,0),(11,2,1,1700000001000,1),(12,3,2,1700000002000,1);
    insert into Messages values(10,'Вхідне'),(11,'Вихідне'),(12,'Дозволений тестовий чат');`,
  );
  fixture.close();
  const original = await readFile(path);
  const rows = await readMessages(path, new Date('2023-01-01T00:00:00Z'));
  expect(rows).toEqual([
    {
      from: '+380671234567',
      text: 'Вхідне',
      at: '2023-11-14T22:13:20.000Z',
      providerMessageId: '10',
      threadId: '2',
      outgoing: false,
    },
    {
      from: '+380671234567',
      text: 'Вихідне',
      at: '2023-11-14T22:13:21.000Z',
      providerMessageId: '11',
      threadId: '2',
      outgoing: true,
    },
    {
      from: '+380638215990',
      text: 'Дозволений тестовий чат',
      at: '2023-11-14T22:13:22.000Z',
      providerMessageId: '12',
      threadId: '3',
      outgoing: true,
    },
  ]);
  expect(
    await readMessages(path, new Date('2023-01-01T00:00:00Z'), [
      '+380638215990',
    ]),
  ).toEqual([rows[2]]);
  expect(await readFile(path)).toEqual(original);
});
