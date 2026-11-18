import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  groupOcrLines,
  classifyViberModal,
  desktopPresenceState,
  normalizeOcr,
  outgoingScreenConfirmed,
  parseTsvWords,
  screenMessageId,
  screenClickPoint,
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

it('requires both the Viber process and visible window for a ready state', () => {
  expect(desktopPresenceState(true, true)).toBe('ready');
  expect(desktopPresenceState(false, true)).toBe('not_running');
  expect(desktopPresenceState(true, false)).toBe('not_running');
});

it('recognizes known recovery and sync overlays from OCR text and fails closed', () => {
  expect(classifyViberModal('Something went wrong. Fix now')).toBe('repair');
  expect(classifyViberModal('Sync chat history')).toBe('sync_history');
  expect(classifyViberModal('Leaving so soon? Close anyway')).toBe(
    'close_confirmation',
  );
  expect(classifyViberModal('Warning: account needs confirmation')).toBe(
    'unknown',
  );
  expect(classifyViberModal('Viber chats')).toBe('none');
});

it('maps displayed screenshot coordinates onto the Xvfb screen', () => {
  expect(screenClickPoint(640, 450, 1280, 900)).toEqual({ x: 640, y: 450 });
  expect(screenClickPoint(320, 225, 640, 450)).toEqual({ x: 640, y: 450 });
  expect(() => screenClickPoint(641, 10, 640, 450)).toThrow('invalid_click');
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
