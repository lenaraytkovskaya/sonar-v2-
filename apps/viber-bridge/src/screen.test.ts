import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  groupOcrLines,
  normalizeOcr,
  outgoingScreenConfirmed,
  parseTsvWords,
  screenMessageId,
  textSimilarity,
} from './screen.js';

it('normalizes OCR text and tolerates small recognition errors', () => {
  expect(normalizeOcr(' Привіт, VIBER! ')).toBe('привітviber');
  expect(textSimilarity('Привіт Viber', 'Привiт Viber')).toBeGreaterThanOrEqual(
    0.8,
  );
  expect(outgoingScreenConfirmed('Привіт Viber', '', 'Привiт Viber')).toBe(
    true,
  );
  expect(
    outgoingScreenConfirmed('Привіт Viber', 'Привіт Viber', 'Привіт Viber'),
  ).toBe(false);
  expect(
    outgoingScreenConfirmed('Очікуваний текст', '', 'Інше повідомлення'),
  ).toBe(false);
});

it('parses OCR coordinates for unread chat badges and lines', () => {
  const tsv = [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '5\t1\t1\t1\t1\t1\t352\t154\t14\t20\t95\t2',
    '5\t1\t1\t1\t2\t1\t430\t190\t64\t18\t90\tHello',
    '5\t1\t1\t1\t2\t2\t502\t190\t55\t18\t90\tViber',
  ].join('\n');
  const words = parseTsvWords(tsv);
  expect(words[0]).toMatchObject({ text: '2', left: 352, top: 154 });
  expect(groupOcrLines(words)[1]?.text).toBe('Hello Viber');
});

it('keeps stable inbound identifiers for the same visible thread, text, and time', () => {
  const first = screenMessageId('thread-1', 'Привіт!', '12:45');
  expect(screenMessageId('thread-1', 'привіт', '12:45')).toBe(first);
  expect(screenMessageId('thread-1', 'привіт', '12:46')).not.toBe(first);
});

it('includes synthetic outgoing-chat and unread-list PNG screenshots', async () => {
  for (const name of ['viber-outgoing.png', 'viber-unread-list.png']) {
    const image = await readFile(
      fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
    );
    expect(image.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(image.readUInt32BE(16)).toBe(1280);
    expect(image.readUInt32BE(20)).toBe(900);
  }
});
