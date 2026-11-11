import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps migration timestamps increasing so existing databases receive every upgrade', () => {
  const journal = JSON.parse(
    readFileSync(
      new URL('../drizzle/meta/_journal.json', import.meta.url),
      'utf8',
    ),
  ) as { entries: { idx: number; when: number }[] };
  for (const [index, entry] of journal.entries.entries()) {
    expect(entry.idx).toBe(index);
    if (index > 0)
      expect(entry.when).toBeGreaterThan(journal.entries[index - 1]!.when);
  }
});

it('keeps the form upgrade newer than the historical deployed email migration', () => {
  const journal = JSON.parse(
    readFileSync(
      new URL('../drizzle/meta/_journal.json', import.meta.url),
      'utf8',
    ),
  ) as { entries: { idx: number; when: number }[] };
  const deployedEmailTimestamp = 1794443000000;
  expect(
    journal.entries.find((entry) => entry.idx === 17)?.when,
  ).toBeGreaterThan(deployedEmailTimestamp);
});
