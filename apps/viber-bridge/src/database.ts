import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const run = promisify(execFile);
export type ViberMessage = {
  from: string;
  text: string;
  at: string;
  providerMessageId: string;
  threadId: string;
  outgoing: boolean;
};
export async function accountDatabase(root: string) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const numbers = entries.filter(
    (entry) => entry.isDirectory() && /^\+?[1-9]\d{6,14}$/.test(entry.name),
  );
  if (numbers.length !== 1) return null;
  return {
    number: `+${numbers[0]!.name.replace(/^\+/, '')}`,
    path: join(root, numbers[0]!.name, 'viber.db'),
  };
}

/** SQLite's read-only backup includes committed WAL records in a consistent copy. */
export async function readMessages(
  path: string,
  since: Date,
): Promise<ViberMessage[]> {
  if (!Number.isFinite(since.getTime())) throw Error('invalid_since');
  const temporary = await mkdtemp(join(tmpdir(), 'sonar-viber-'));
  const copy = join(temporary, 'snapshot.db');
  try {
    await run(
      'sqlite3',
      ['-readonly', '-cmd', '.timeout 3000', path, `.backup '${copy}'`],
      { timeout: 5000 },
    );
    // Undocumented desktop schema: reject changes instead of guessing message identity/direction.
    const query = `select cast(e.EventID as text) as id,cast(e.ChatID as text) as thread,
      c.Number as phone,m.Body as text,e.TimeStamp as time,e.Direction as direction
      from Events e join Messages m on m.EventID=e.EventID
      join Contact c on c.ContactID=e.ContactID
      where e.TimeStamp>=${since.getTime()} and e.Direction in (0,1) and m.Body<>''
      order by e.TimeStamp,e.EventID limit 10001`;
    const { stdout } = await run(
      'sqlite3',
      ['-readonly', '-json', copy, query],
      { timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
    );
    const rows = JSON.parse(stdout || '[]') as {
      id: string;
      thread: string;
      phone: string;
      text: string;
      time: number;
      direction: number;
    }[];
    if (rows.length > 10000) throw Error('inbound_batch_overflow');
    return rows
      .filter(
        (row) =>
          /^\+?[1-9]\d{6,14}$/.test(row.phone) &&
          row.thread &&
          row.id &&
          typeof row.text === 'string',
      )
      .map((row) => ({
        from: `+${row.phone.replace(/^\+/, '')}`,
        text: row.text,
        at: new Date(row.time).toISOString(),
        providerMessageId: row.id,
        threadId: row.thread,
        outgoing: row.direction === 1,
      }));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
