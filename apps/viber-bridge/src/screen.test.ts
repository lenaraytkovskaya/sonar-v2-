import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { expect, it } from 'vitest';
import {
  groupOcrLines,
  classifyViberModal,
  chatColumnBounds,
  chatHeaderMatchesRecipient,
  desktopPresenceState,
  normalizeOcr,
  messageTimeAtOrAfter,
  outgoingScreenConfirmed,
  parseTsvWords,
  screenMessageId,
  screenClickPoint,
  safeLayoutClick,
  textSimilarity,
  verticalColorBoundaries,
} from './screen.js';

function syntheticLayoutPng() {
  const width = 1280;
  const height = 900;
  const pixels = Buffer.alloc(width * height * 3);
  const paint = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: number[],
  ) => {
    for (let y = y1; y < y2; y++)
      for (let x = x1; x < x2; x++) pixels.set(color, (y * width + x) * 3);
  };
  paint(0, 0, width, height, [239, 242, 247]);
  paint(0, 0, 145, height, [255, 255, 255]);
  paint(1135, 0, width, height, [210, 218, 229]);
  paint(145, 55, 1135, 120, [117, 71, 174]); // New-contact banner.
  paint(690, 170, 1080, 250, [209, 237, 248]); // Wrapped outgoing bubble.
  paint(145, 790, 1135, 860, [255, 255, 255]); // Composer.
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let value = n;
    for (let bit = 0; bit < 8; bit++)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const crc = (buffer: Buffer) => {
    let value = 0xffffffff;
    for (const byte of buffer)
      value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++)
    pixels.copy(
      rows,
      y * (width * 3 + 1) + 1,
      y * width * 3,
      (y + 1) * width * 3,
    );
  return {
    width,
    height,
    pixels,
    png: Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(rows)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  };
}

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
  ).toBe(true);
  expect(
    outgoingScreenConfirmed('Очікуваний текст', '', 'Інше повідомлення'),
  ).toBe(false);
});

it('confirms wrapped outgoing text in the dynamic chat column with a sent time', () => {
  const expected = 'Ми підготували пропозицію для вас · можна обговорити?';
  const wrapped = 'Ми підготували пропозицію\nдля вас — можна обговорити';
  expect(
    outgoingScreenConfirmed(
      expected,
      'draft still visible',
      wrapped,
      '15:02',
      new Date('2026-11-18T15:01:00'),
    ),
  ).toBe(true);
  expect(
    outgoingScreenConfirmed(
      expected,
      '',
      wrapped,
      '15:00',
      new Date('2026-11-18T15:01:00'),
    ),
  ).toBe(false);
  expect(messageTimeAtOrAfter('00:00', new Date('2026-11-18T23:59:40'))).toBe(
    true,
  );
});

it('uses color separators and protects Block actions in a synthetic Viber layout PNG', () => {
  const image = syntheticLayoutPng();
  expect(image.png.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  expect(image.png.readUInt32BE(16)).toBe(image.width);
  expect(image.png.readUInt32BE(20)).toBe(image.height);
  const banner = (65 * image.width + 180) * 3;
  expect([...image.pixels.subarray(banner, banner + 3)]).toEqual([
    117, 71, 174,
  ]);
  const wrappedBubble = (180 * image.width + 700) * 3;
  expect([...image.pixels.subarray(wrappedBubble, wrappedBubble + 3)]).toEqual([
    209, 237, 248,
  ]);
  const row = Array.from({ length: image.width }, (_, x) => {
    const offset = (140 * image.width + x) * 3;
    return [
      image.pixels[offset]!,
      image.pixels[offset + 1]!,
      image.pixels[offset + 2]!,
    ] as const;
  });
  const boundaries = verticalColorBoundaries(row);
  expect(boundaries).toContain(145);
  expect(boundaries).toContain(1135);
  expect(chatColumnBounds(image.width, boundaries, true)).toEqual({
    left: 145,
    right: 1135,
  });
  const block = [{ left: 980, top: 85, right: 1040, bottom: 110 }];
  expect(safeLayoutClick(1120, 90, block)).toBe(true);
  expect(safeLayoutClick(1010, 98, block)).toBe(false);
  expect(
    chatHeaderMatchesRecipient(
      'Olena Kovalenko\n+380 63 705 85 71',
      '+380637058571',
    ),
  ).toBe(true);
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
