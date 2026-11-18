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
  phoneFromOcrLines,
  screenMessageId,
  screenClickPoint,
  safeLayoutClick,
  textSimilarity,
  verticalColorBoundaries,
  visibleInboundMessages,
  messageBubbleRegions,
  inboundBubbleMessage,
  copyMenuPoint,
  exactOptionPoint,
  clipboardChanged,
  normalizeMessageText,
  visibleTimeText,
} from './screen.js';

function syntheticBubblePixels() {
  const width = 640;
  const height = 400;
  const pixels = new Uint8Array(width * height * 3);
  const paint = (
    left: number,
    top: number,
    right: number,
    bottom: number,
    color: readonly [number, number, number],
  ) => {
    for (let y = top; y < bottom; y++)
      for (let x = left; x < right; x++) pixels.set(color, (y * width + x) * 3);
  };
  paint(0, 0, width, height, [220, 224, 230]);
  paint(50, 125, 280, 200, [255, 255, 255]);
  paint(55, 220, 260, 295, [255, 255, 255]);
  paint(360, 125, 610, 200, [117, 71, 174]);
  paint(220, 75, 420, 105, [190, 190, 190]); // centered encryption notice
  return { width, height, pixels };
}

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
  paint(180, 165, 480, 245, [255, 255, 255]); // Incoming bubble in the open chat.
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

it('normalizes OCR and clipboard text while confirming outgoing text exactly', () => {
  expect(normalizeOcr(' Привіт, VIBER! ')).toBe('привітviber');
  expect(textSimilarity('Привіт Viber', 'Привiт Viber')).toBeGreaterThanOrEqual(
    0.8,
  );
  expect(outgoingScreenConfirmed('Привіт Viber', '', 'Привiт Viber')).toBe(
    false,
  );
  expect(
    outgoingScreenConfirmed('Привіт Viber', 'Привіт Viber', 'Привіт Viber'),
  ).toBe(true);
  expect(
    outgoingScreenConfirmed('Очікуваний текст', '', 'Інше повідомлення'),
  ).toBe(false);
  expect(normalizeMessageText('  Привіт\n   світе 🙂 ')).toBe(
    'Привіт світе 🙂',
  );
  expect(outgoingScreenConfirmed('Hello  world', '', 'Hello\nworld')).toBe(
    true,
  );
});

it('recovers a compact OCR timestamp when the colon is unreadable', () => {
  expect(visibleTimeText('19:17')).toBe('19:17');
  expect(visibleTimeText('1917')).toBe('19:17');
  expect(visibleTimeText('V6 1917')).toBe('19:17');
  expect(visibleTimeText('2561')).toBeUndefined();
});

it('isolates bubble backgrounds, skips centered and outgoing bubbles, and keeps message text intact', () => {
  const image = syntheticBubblePixels();
  const bubbles = messageBubbleRegions(
    image.pixels,
    image.width,
    image.height,
    { left: 20, right: 620 },
    110,
  );
  expect(bubbles.map(({ side, top }) => [side, top])).toEqual([
    ['left', 125],
    ['right', 125],
    ['left', 220],
  ]);
  const first = inboundBubbleMessage(
    [
      { text: 'перше повідомлення', left: 0, top: 0, right: 90 },
      { text: 'з двох рядків', left: 0, top: 15, right: 80 },
      { text: '17:12', left: 0, top: 32, right: 30 },
    ],
    {
      threadId: 'screen:+380638215990',
      from: '+380637058571',
      since: new Date('2026-11-18T17:11:00Z'),
      reference: new Date('2026-11-18T17:20:00Z'),
      region: bubbles[0]!,
      copiedText: 'перше повідомлення\nз двох рядків',
    },
  );
  expect(first).toMatchObject({
    text: 'перше повідомлення\nз двох рядків',
    at: '2026-11-18T17:12:00.000Z',
  });
  expect(
    inboundBubbleMessage(
      [
        {
          text: "Messages in this chat are private and protected by Viber's end-to-end encryption.",
          left: 0,
          top: 0,
          right: 250,
        },
      ],
      {
        threadId: 'screen:+380638215990',
        from: '+380637058571',
        since: new Date('2026-11-18T17:11:00Z'),
        reference: new Date('2026-11-18T17:20:00Z'),
        region: {
          left: 200,
          top: 100,
          right: 500,
          bottom: 180,
          side: 'center',
        },
      },
    ),
  ).toBeNull();
  expect(
    inboundBubbleMessage(
      [
        { text: 'V5 test one', left: 0, top: 0, right: 90 },
        { text: '17:48', left: 0, top: 20, right: 30 },
      ],
      {
        threadId: 'screen:+380638215990',
        from: '+380637058571',
        since: new Date('2026-11-18T17:11:00Z'),
        reference: new Date('2026-11-18T17:20:00Z'),
        region: bubbles[1]!,
        copiedText: 'outgoing text',
      },
    ),
  ).toBeNull();
  expect(
    inboundBubbleMessage(
      [
        { text: 'друге повідомлення', left: 0, top: 0, right: 90 },
        { text: '17:13', left: 0, top: 20, right: 30 },
      ],
      {
        threadId: 'screen:+380638215990',
        from: '+380637058571',
        since: new Date('2026-11-18T17:11:00Z'),
        reference: new Date('2026-11-18T17:20:00Z'),
        region: bubbles[2]!,
        copiedText: 'друге повідомлення',
      },
    ),
  ).toMatchObject({
    text: 'друге повідомлення',
    at: '2026-11-18T17:13:00.000Z',
  });
  expect(
    inboundBubbleMessage([{ text: '17:12', left: 0, top: 0, right: 30 }], {
      threadId: 'screen:+380638215990',
      from: '+380637058571',
      since: new Date('2026-11-18T17:11:00Z'),
      reference: new Date('2026-11-18T17:20:00Z'),
      region: bubbles[1]!,
    }),
  ).toBeNull();
  expect(
    inboundBubbleMessage([{ text: '17:12', left: 0, top: 0, right: 30 }], {
      threadId: 'screen:+380638215990',
      from: '+380637058571',
      since: new Date('2026-11-18T17:12:35Z'),
      reference: new Date('2026-11-18T17:20:00Z'),
      region: bubbles[0]!,
      copiedText: 'same minute',
    }),
  ).toMatchObject({ text: 'same minute', at: '2026-11-18T17:12:00.000Z' });
});

it('selects only an exact localized Copy menu item and requires clipboard change', () => {
  expect(
    copyMenuPoint([
      { text: 'Copy', left: 20, top: 30, right: 65 },
      { text: 'Forward', left: 20, top: 50, right: 80 },
    ]),
  ).toEqual({ x: 43, y: 40 });
  expect(
    copyMenuPoint([{ text: 'Copy message', left: 20, top: 30, right: 100 }]),
  ).toEqual({ x: 60, y: 40 });
  expect(
    copyMenuPoint([{ text: 'й! Copy message', left: 20, top: 30, right: 120 }]),
  ).toEqual({ x: 70, y: 40 });
  expect(
    copyMenuPoint([{ text: 'Copy link', left: 1, top: 2, right: 60 }]),
  ).toBeNull();
  expect(
    copyMenuPoint([{ text: 'Копіювати', left: 10, top: 15, right: 90 }]),
  ).toEqual({ x: 50, y: 25 });
  expect(
    exactOptionPoint(
      [{ text: 'Yes', left: 120, top: 500, right: 160 }],
      ['Yes', 'Так'],
    ),
  ).toEqual({ x: 140, y: 510 });
  expect(
    exactOptionPoint(
      [{ text: 'Yes, sync', left: 120, top: 500, right: 190 }],
      ['Yes', 'Так'],
    ),
  ).toBeNull();
  expect(clipboardChanged('', 'exact copied text')).toBe(true);
  expect(clipboardChanged('', '')).toBe(false);
  expect(clipboardChanged('old', 'old')).toBe(false);
});

it('requires exact copied outgoing text after whitespace normalization and a sent time', () => {
  const expected = 'Ми підготували пропозицію для вас · можна обговорити?';
  const wrapped = 'Ми підготували пропозицію\nдля вас — можна обговорити';
  expect(
    outgoingScreenConfirmed(
      expected,
      'draft still visible',
      expected.replaceAll(' ', '\n'),
      '15:02',
      new Date('2026-11-18T15:01:00'),
    ),
  ).toBe(true);
  expect(
    outgoingScreenConfirmed(
      expected,
      '',
      wrapped,
      '15:02',
      new Date('2026-11-18T15:01:00'),
    ),
  ).toBe(false);
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
  expect(chatColumnBounds(image.width, boundaries).right).toBe(1135);
  expect(chatColumnBounds(1280, [299, 640], true).right).toBe(640);
  expect(
    chatColumnBounds(1280, [299, 934, 955, 972, 1027, 1168], true).right,
  ).toBe(972);
  const block = [{ left: 980, top: 85, right: 1040, bottom: 110 }];
  expect(safeLayoutClick(1120, 90, block)).toBe(true);
  expect(safeLayoutClick(1010, 98, block)).toBe(false);
  expect(
    chatHeaderMatchesRecipient(
      'Olena Kovalenko\n+380 63 705 85 71',
      '+380637058571',
    ),
  ).toBe(true);
  expect(
    phoneFromOcrLines(
      [
        { text: 'Olena Kovalenko Active', left: 180, top: 60, right: 360 },
        {
          text: 'Olena +380 63 705 85 71 is not in your contact list',
          left: 180,
          top: 90,
          right: 650,
        },
      ],
      (line) => line.top < 210 && line.left >= 145 && line.left < 1135,
    ),
  ).toBe('+380637058571');
  expect(
    phoneFromOcrLines(
      [{ text: '+380 63 705 85 71', left: 1145, top: 185, right: 1270 }],
      (line) => line.top < 495 && line.left >= 1130,
    ),
  ).toBe('+380637058571');
  expect(
    chatHeaderMatchesRecipient(
      'Olena Kovalenko Active\nOlena +380 63 705 85 71 is not in your contact list',
      '+380637058571',
    ),
  ).toBe(true);
  const incoming = visibleInboundMessages(
    [
      { text: 'відповідь у', left: 180, top: 170, right: 260 },
      { text: 'два рядки', left: 180, top: 185, right: 255 },
      { text: '15:02', left: 180, top: 205, right: 215 },
      { text: 'outgoing must be ignored', left: 710, top: 175, right: 900 },
      { text: '15:03', left: 990, top: 215, right: 1025 },
    ],
    {
      threadId: 'screen:380637058571',
      from: '+380637058571',
      since: new Date('2026-11-18T15:01:00'),
      reference: new Date('2026-11-18T15:04:00'),
      left: 145,
      right: 1135,
      headerBottom: 140,
      height: 900,
    },
  );
  expect(incoming).toHaveLength(1);
  expect(incoming[0]).toMatchObject({
    from: '+380637058571',
    text: 'відповідь у два рядки',
  });
  expect(new Date(incoming[0]!.at).getHours()).toBe(15);
  expect(new Date(incoming[0]!.at).getMinutes()).toBe(2);
  expect(incoming[0]?.providerMessageId).toBe(
    screenMessageId('screen:380637058571', 'відповідь у два рядки', '15:02'),
  );
});

it('requires both the Viber process and visible window for a ready state', () => {
  expect(desktopPresenceState(true, true)).toBe('ready');
  expect(desktopPresenceState(false, true)).toBe('not_running');
  expect(desktopPresenceState(true, false)).toBe('not_running');
});

it('recognizes known recovery and sync overlays from OCR text and fails closed', () => {
  expect(classifyViberModal('Something went wrong. Fix now')).toBe('repair');
  expect(classifyViberModal('Sync chat history')).toBe('sync_history');
  expect(
    classifyViberModal('Syncing canceled. Chat history will not be synced'),
  ).toBe('sync_canceled');
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
  const first = screenMessageId('thread-1', 'Привіт! ', '12:45');
  expect(screenMessageId('thread-1', 'Привіт!\n', '12:45')).toBe(first);
  expect(screenMessageId('thread-1', 'привіт', '12:45')).not.toBe(first);
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

it('keeps the anonymized test Viber chat crop as a fixture', async () => {
  const image = await readFile(
    fileURLToPath(
      new URL('./fixtures/viber-inbound-live.png', import.meta.url),
    ),
  );
  expect(image.readUInt32BE(16)).toBe(680);
  expect(image.readUInt32BE(20)).toBe(625);
});
