import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { chatUrl, createSend } from './send.js';
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
it('confirms the empty composer and matching outgoing OCR bubble without a database', async () => {
  const path = await temporary();
  const enter = vi.fn();
  const confirm = vi.fn().mockResolvedValue({
    composer: '',
    outgoingBubble: 'Привіт & + ? Другий рядок',
  });
  const desktop = {
    messages: vi.fn().mockRejectedValue(Error('encrypted_database')),
    open: vi.fn(),
    enter,
    confirm,
    screen: async () => Buffer.from('synthetic screenshot'),
    wait: async () => {},
  };
  const send = createSend(path, desktop);
  const first = await send(input);
  expect(first.state).toBe('sent');
  expect(first.providerMessageId).toMatch(/^screen:/);
  expect(await createSend(path, desktop)(input)).toEqual(first);
  expect(enter).toHaveBeenCalledTimes(1);
  expect(confirm).toHaveBeenCalledTimes(1);
});
it('keeps checking exact copied screen text when the Viber database is unreadable', async () => {
  const confirm = vi
    .fn()
    .mockResolvedValueOnce({ composer: '', outgoingBubble: 'wrong text' })
    .mockResolvedValue({
      composer: '',
      outgoingBubble: input.text.replaceAll(' ', '\n'),
    });
  const wait = vi.fn().mockResolvedValue(undefined);
  const result = await createSend(await temporary(), {
    messages: vi.fn().mockRejectedValue(Error('encrypted_database')),
    open: vi.fn().mockResolvedValue(undefined),
    enter: vi.fn().mockResolvedValue(undefined),
    confirm,
    screen: async () => Buffer.from('synthetic screenshot'),
    wait,
  })(input);
  expect(result.state).toBe('sent');
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(wait).toHaveBeenCalledTimes(2);
});
it('reads a synthetic Viber SQLite snapshot and leaves the source unchanged', async () => {
  const path = join(await temporary(), 'viber.db');
  const fixture = new DatabaseSync(path);
  fixture.exec(
    `create table Contact(ContactID integer,Number text);
    create table Events(EventID integer,ChatID integer,ContactID integer,TimeStamp integer,Direction integer);
    create table Messages(EventID integer,Body text);
    insert into Contact values(1,'380671234567');
    insert into Events values(10,2,1,1700000000000,0),(11,2,1,1700000001000,1);
    insert into Messages values(10,'Вхідне'),(11,'Вихідне');`,
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
  ]);
  expect(await readFile(path)).toEqual(original);
});
