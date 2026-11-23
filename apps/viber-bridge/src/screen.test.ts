import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { expect, it } from 'vitest';
import {
  groupOcrLines,
  groupOcrLinesWithinBounds,
  classifyViberModal,
  chatColumnBounds,
  chatgptPanelHeader,
  chatHeaderMatchesRecipient,
  desktopPresenceState,
  normalizeOcr,
  messageTimeAtOrAfter,
  outgoingScreenConfirmed,
  outgoingBubbleText,
  outgoingSliceConfirmed,
  sameBubbleColumn,
  deriveMessageBodyTop,
  unfilledEmojiBody,
  bubbleContentSignature,
  parseTsvWords,
  phoneFromOcrLines,
  screenMessageId,
  screenClickPoint,
  safeLayoutClick,
  textSimilarity,
  verticalColorBoundaries,
  visibleInboundMessages,
  messageBubbleRegions,
  isOutgoingBubbleColor,
  inboundBubbleMessage,
  inboundBubbleRegionsFromOcr,
  inboundOcrFallbackText,
  copyMenuPoint,
  copyMenuSearchRegion,
  exactOptionPoint,
  myNotesMenuPoint,
  isMyNotesTitle,
  hasMyNotesHeader,
  clipboardChanged,
  normalizeMessageText,
  visibleTimeText,
  visibleTimestampLine,
  visibleDateSeparator,
  daySeparatorAt,
  visibleMessageTimestamp,
} from './screen.js';

it('tracks a long bubble body after its protruding footer tail scrolls out of view', () => {
  // Authorized My Notes capture: tail x=510..860, visible body x=511..852.
  const tail = { left: 510, right: 860 };
  expect(sameBubbleColumn({ left: 511, right: 852 }, tail)).toBe(true);
  expect(sameBubbleColumn({ left: 300, right: 650 }, tail)).toBe(false);
  expect(sameBubbleColumn({ left: 510, right: 600 }, tail)).toBe(false);
});

function syntheticBubblePixels() {
  const width = 640;
  const height = 500;
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
  paint(320, 310, 480, 370, [117, 71, 174]); // outgoing bubble left of midpoint.
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
  expect(visibleTimestampLine('1712')).toBe('17:12');
  expect(visibleTimestampLine('18:45 ✓✓')).toBe('18:45');
  expect(visibleTimestampLine('Зустріч о 18:45')).toBeUndefined();
});

it('assigns Viber message times to visible day separators and never returns future times', () => {
  const reference = new Date('2026-11-19T18:00:00');
  const expectedYesterday = new Date(reference);
  expectedYesterday.setDate(expectedYesterday.getDate() - 1);
  expectedYesterday.setHours(18, 45, 0, 0);
  const yesterdayLabels = ['Yesterday', 'Вчора', 'Вчера'];
  for (const label of yesterdayLabels) {
    const separator = visibleDateSeparator(label, reference)!;
    expect(
      visibleMessageTimestamp('18:45', reference, separator)?.getTime(),
    ).toBe(expectedYesterday.getTime());
  }
  for (const label of ['Today', 'Сьогодні', 'Сегодня']) {
    const separator = visibleDateSeparator(label, reference)!;
    expect(
      visibleMessageTimestamp('17:12', reference, separator)?.getDate(),
    ).toBe(reference.getDate());
  }
  for (const label of ['18 November', '18 листопада', '18 ноября']) {
    const separator = visibleDateSeparator(label, reference)!;
    expect(
      visibleMessageTimestamp('18:45', reference, separator)?.getDate(),
    ).toBe(18);
  }
  const noDividerFuture = visibleMessageTimestamp('19:17', reference)!;
  expect(noDividerFuture.getDate()).toBe(18);
  expect(noDividerFuture.getTime()).toBeLessThanOrEqual(reference.getTime());
  expect(visibleMessageTimestamp('17:12', reference)?.getDate()).toBe(19);
});

it('interprets visible Viber times in the configured local timezone', () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = 'Europe/Kyiv';
  try {
    const reference = new Date('2026-11-19T09:52:00.000Z');
    expect(visibleMessageTimestamp('11:47', reference)?.toISOString()).toBe(
      '2026-11-19T09:47:00.000Z',
    );
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});

it('uses a date divider below a bubble to infer the preceding day', () => {
  const reference = new Date('2026-11-19T18:00:00');
  const separator = daySeparatorAt(
    [{ text: 'Today', top: 300 }],
    240,
    reference,
  );
  expect(separator?.getDate()).toBe(18);
  expect(
    visibleMessageTimestamp('18:45', reference, separator)?.getDate(),
  ).toBe(18);
  expect(daySeparatorAt([], 240, reference)).toBeUndefined();
});

it('imports visible bubbles in chronological order and skips unknown dates', () => {
  const input = {
    threadId: 'screen:380501234567',
    from: '+380501234567',
    since: new Date('2026-11-18T00:00:00'),
    reference: new Date('2026-11-19T18:00:00'),
    left: 145,
    right: 1135,
    headerBottom: 140,
    height: 900,
  };
  const lines = [
    { text: 'Previous day message', left: 180, top: 170, right: 360 },
    { text: '23:59', left: 180, top: 195, right: 220 },
    { text: 'Today', left: 300, top: 240, right: 350 },
    { text: 'Today message', left: 180, top: 260, right: 330 },
    { text: '10:01', left: 180, top: 285, right: 220 },
  ];
  const messages = visibleInboundMessages(lines, input);
  expect(messages.map((message) => message.at)).toEqual([
    new Date('2026-11-18T23:59:00').toISOString(),
    new Date('2026-11-19T10:01:00').toISOString(),
  ]);
  expect(visibleInboundMessages(lines.slice(0, 2), input)).toHaveLength(0);
});

it('applies the nearest visible date divider to an inbound message', () => {
  const incoming = visibleInboundMessages(
    [
      { text: '18 листопада', left: 300, top: 150, right: 470 },
      { text: 'Вчорашнє повідомлення', left: 180, top: 170, right: 390 },
      { text: '18:45', left: 180, top: 195, right: 220 },
    ],
    {
      threadId: 'screen:380501234567',
      from: '+380501234567',
      since: new Date('2026-11-18T18:00:00'),
      reference: new Date('2026-11-19T18:00:00'),
      left: 145,
      right: 1135,
      headerBottom: 140,
      height: 900,
    },
  );
  expect(incoming[0]?.at).toBe(new Date(2026, 10, 18, 18, 45).toISOString());
  expect(incoming[0]?.text).toBe('Вчорашнє повідомлення');
});

it('keeps a chat timestamp when sidebar text shares the same OCR row', () => {
  const words = [
    { text: '17:12', left: 915, top: 302, width: 30, height: 12 },
    { text: 'Chats', left: 22, top: 302, width: 35, height: 12 },
    { text: 'ChatGPT', left: 1030, top: 302, width: 55, height: 12 },
  ];
  expect(groupOcrLines(words)[0]?.left).toBe(22);
  expect(groupOcrLinesWithinBounds(words, { left: 299, right: 980 })).toEqual([
    { text: '17:12', left: 915, top: 302, right: 945 },
  ]);
  expect(
    visibleTimeText(
      groupOcrLinesWithinBounds(words, { left: 299, right: 980 })[0]!.text,
    ),
  ).toBe('17:12');
});

it('does not trust a URI-opened chat header without the recipient number', () => {
  expect(chatHeaderMatchesRecipient('Other Company', '+380638215990')).toBe(
    false,
  );
});

it('ignores a full-width violet banner when looking for message bubbles', () => {
  const width = 640;
  const height = 500;
  const pixels = new Uint8Array(width * height * 3);
  const paint = (l: number, t: number, r: number, b: number, c: number[]) => {
    for (let y = t; y < b; y++)
      for (let x = l; x < r; x++) pixels.set(c, (y * width + x) * 3);
  };
  paint(0, 0, width, height, [239, 242, 247]);
  paint(20, 112, 620, 240, [51, 37, 136]); // "Not in your contact list" banner.
  paint(480, 300, 600, 340, [117, 97, 255]); // The real outgoing bubble.
  const bubbles = messageBubbleRegions(
    pixels,
    width,
    height,
    { left: 20, right: 620 },
    110,
  );
  expect(bubbles.map(({ side, top }) => [side, top])).toEqual([['right', 300]]);
});

it('ignores a banner under the chat header even when the chat bounds include a side panel', () => {
  const width = 1280;
  const height = 900;
  const pixels = new Uint8Array(width * height * 3);
  const paint = (l: number, t: number, r: number, b: number, c: number[]) => {
    for (let y = t; y < b; y++)
      for (let x = l; x < r; x++) pixels.set(c, (y * width + x) * 3);
  };
  paint(0, 0, width, height, [239, 242, 247]);
  paint(304, 113, 865, 242, [30, 20, 110]);
  paint(700, 404, 852, 461, [117, 97, 255]);
  const bubbles = messageBubbleRegions(
    pixels,
    width,
    height,
    { left: 300, right: 1280 },
    112,
  );
  expect(bubbles.map(({ side, top }) => [side, top])).toEqual([['right', 404]]);
});

it('finds a very short outgoing message bubble', () => {
  const width = 1280;
  const height = 900;
  const pixels = new Uint8Array(width * height * 3);
  const paint = (l: number, t: number, r: number, b: number, c: number[]) => {
    for (let y = t; y < b; y++)
      for (let x = l; x < r; x++) pixels.set(c, (y * width + x) * 3);
  };
  paint(0, 0, width, height, [239, 242, 247]);
  paint(773, 404, 852, 461, [117, 97, 255]); // "qwe", 79px wide
  const bubbles = messageBubbleRegions(
    pixels,
    width,
    height,
    { left: 300, right: 868 },
    112,
  );
  expect(bubbles.map(({ side, top }) => [side, top])).toEqual([['right', 404]]);
});

it('isolates bubble backgrounds, skips centered and outgoing bubbles, and keeps message text intact', () => {
  // Visible timestamps and day separators share the fixture's local wall clock.
  const localTime = (hours: number, minutes: number, seconds = 0) =>
    new Date(2026, 10, 18, hours, minutes, seconds);
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
    ['right', 310],
  ]);
  expect(isOutgoingBubbleColor([117, 71, 174])).toBe(true);
  expect(isOutgoingBubbleColor([209, 237, 248])).toBe(false);
  const first = inboundBubbleMessage(
    [
      { text: 'перше повідомлення', left: 0, top: 0, right: 90 },
      { text: 'з двох рядків', left: 0, top: 15, right: 80 },
      { text: '17:12', left: 0, top: 32, right: 30 },
    ],
    {
      threadId: 'screen:+380638215990',
      from: '+380501234567',
      since: localTime(17, 11),
      reference: localTime(17, 20),
      region: bubbles[0]!,
      copiedText: 'перше повідомлення\nз двох рядків',
      daySeparator: new Date(2026, 10, 18),
    },
  );
  expect(first).toMatchObject({
    text: 'перше повідомлення\nз двох рядків',
    at: localTime(17, 12).toISOString(),
  });
  const ocrLines = [
    { text: 'перше повідомлення', left: 0, top: 0, right: 90 },
    { text: 'з двох рядків', left: 0, top: 15, right: 80 },
    { text: '17:12', left: 0, top: 32, right: 30 },
  ];
  const fallbackText = inboundOcrFallbackText(ocrLines);
  expect(fallbackText).toBe('перше повідомлення\nз двох рядків');
  expect(
    inboundOcrFallbackText([
      ...ocrLines,
      { text: 'Report spam', left: 0, top: 40, right: 80 },
      { text: 'Block and', left: 0, top: 50, right: 80 },
    ]),
  ).toBe('перше повідомлення\nз двох рядків');
  const fallback = inboundBubbleMessage(ocrLines, {
    threadId: 'screen:+380638215990',
    from: '+380501234567',
    since: localTime(17, 11),
    reference: localTime(17, 20),
    region: bubbles[0]!,
    copiedText: fallbackText,
    daySeparator: new Date(2026, 10, 18),
  });
  const copiedLater = inboundBubbleMessage(ocrLines, {
    threadId: 'screen:+380638215990',
    from: '+380501234567',
    since: localTime(17, 11),
    reference: localTime(17, 20),
    region: bubbles[0]!,
    copiedText: 'перше повідомлення\nз двох рядків',
    dedupeText: fallbackText,
    daySeparator: new Date(2026, 10, 18),
  });
  expect(fallback?.providerMessageId).toBe(copiedLater?.providerMessageId);
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
        from: '+380501234567',
        since: localTime(17, 11),
        reference: localTime(17, 20),
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
        from: '+380501234567',
        since: localTime(17, 11),
        reference: localTime(17, 20),
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
        from: '+380501234567',
        since: localTime(17, 11),
        reference: localTime(17, 20),
        region: bubbles[2]!,
        copiedText: 'друге повідомлення',
        daySeparator: new Date(2026, 10, 18),
      },
    ),
  ).toMatchObject({
    text: 'друге повідомлення',
    at: localTime(17, 13).toISOString(),
  });
  expect(
    inboundBubbleMessage([{ text: '17:12', left: 0, top: 0, right: 30 }], {
      threadId: 'screen:+380638215990',
      from: '+380501234567',
      since: localTime(17, 11),
      reference: localTime(17, 20),
      region: bubbles[1]!,
    }),
  ).toBeNull();
  expect(
    inboundBubbleMessage([{ text: '17:12', left: 0, top: 0, right: 30 }], {
      threadId: 'screen:+380638215990',
      from: '+380501234567',
      since: localTime(17, 12, 35),
      reference: localTime(17, 20),
      region: bubbles[0]!,
      copiedText: 'same minute',
      daySeparator: new Date(2026, 10, 18),
    }),
  ).toMatchObject({ text: 'same minute', at: localTime(17, 12).toISOString() });
});

it('infers inbound bubbles from left-column text and timestamps when colors blend into wallpaper', () => {
  expect(
    inboundBubbleRegionsFromOcr(
      [
        {
          text: 'Sonar 2.9.5 test: exact text',
          left: 318,
          top: 477,
          right: 558,
        },
        {
          text: 'Second line / second line',
          left: 328,
          top: 495,
          right: 520,
        },
        { text: '21:29', left: 549, top: 523, right: 576 },
        {
          text: 'Sonar 2.9.6 test: confirmation',
          left: 318,
          top: 590,
          right: 557,
        },
        {
          text: 'Second row / line two',
          left: 328,
          top: 610,
          right: 515,
        },
        { text: '09:47', left: 549, top: 643, right: 576 },
        { text: '18:45', left: 770, top: 350, right: 800 },
      ],
      { bounds: { left: 299, right: 980 }, headerBottom: 140, height: 900 },
    ),
  ).toEqual([
    { left: 304, top: 467, right: 590, bottom: 541, side: 'left' },
    { left: 304, top: 580, right: 590, bottom: 661, side: 'left' },
  ]);
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
    copyMenuPoint([
      { text: '[] Copy message', left: 410, top: 455, right: 530 },
    ]),
  ).toEqual({ x: 470, y: 465 });
  expect(
    copyMenuPoint([
      { text: 'Delete for myself', left: 410, top: 695, right: 570 },
    ]),
  ).toBeNull();
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

it('searches all sides of the context click and clips the OCR crop to screen bounds', () => {
  expect(copyMenuSearchRegion(640, 455, 1280, 900)).toEqual({
    left: 290,
    top: 105,
    width: 700,
    height: 700,
    crop: '700x700+290+105',
  });
  expect(copyMenuSearchRegion(50, 880, 1280, 900)).toMatchObject({
    left: 0,
    top: 530,
    width: 400,
    height: 370,
  });
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
  expect(chatColumnBounds(image.width, boundaries, true).right).toBe(1135);
  expect(chatColumnBounds(image.width, boundaries).right).toBe(image.width);
  expect(chatColumnBounds(1280, [299, 1241]).right).toBe(1280);
  expect(chatColumnBounds(1280, [299, 640], true).right).toBe(640);
  expect(
    chatColumnBounds(1280, [299, 934, 955, 972, 1027, 1168], true).right,
  ).toBe(972);
  const block = [{ left: 980, top: 85, right: 1040, bottom: 110 }];
  expect(safeLayoutClick(1120, 90, block)).toBe(true);
  expect(safeLayoutClick(1010, 98, block)).toBe(false);
  const forbiddenActions = [
    { left: 410, top: 191, right: 450, bottom: 207 }, // banner: Block
    { left: 1030, top: 186, right: 1075, bottom: 204 }, // banner: Report spam
    { left: 1030, top: 374, right: 1080, bottom: 394 }, // panel: Clear chat
  ];
  expect(safeLayoutClick(430, 198, forbiddenActions)).toBe(false);
  expect(safeLayoutClick(1080, 410, forbiddenActions)).toBe(false);
  expect(safeLayoutClick(1110, 450, forbiddenActions)).toBe(true);
  expect(
    chatHeaderMatchesRecipient(
      'Olena Kovalenko\n+380 50 123 45 67',
      '+380501234567',
    ),
  ).toBe(true);
  expect(
    phoneFromOcrLines(
      [
        { text: 'Olena Kovalenko Active', left: 180, top: 60, right: 360 },
        {
          text: 'Olena +380 50 123 45 67 is not in your contact list',
          left: 180,
          top: 90,
          right: 650,
        },
      ],
      (line) => line.top < 210 && line.left >= 145 && line.left < 1135,
    ),
  ).toBe('+380501234567');
  expect(
    phoneFromOcrLines(
      [{ text: '+380 50 123 45 67', left: 1145, top: 185, right: 1270 }],
      (line) => line.top < 495 && line.left >= 1130,
    ),
  ).toBe('+380501234567');
  expect(
    chatHeaderMatchesRecipient(
      'Olena Kovalenko Active\nOlena +380 50 123 45 67 is not in your contact list',
      '+380501234567',
    ),
  ).toBe(true);
  const incoming = visibleInboundMessages(
    [
      { text: 'Today', left: 300, top: 150, right: 350 },
      { text: 'відповідь у', left: 180, top: 170, right: 260 },
      { text: 'два рядки', left: 180, top: 185, right: 255 },
      { text: '15:02', left: 180, top: 205, right: 215 },
      { text: 'outgoing must be ignored', left: 710, top: 175, right: 900 },
      { text: '15:03', left: 990, top: 215, right: 1025 },
    ],
    {
      threadId: 'screen:380501234567',
      from: '+380501234567',
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
    from: '+380501234567',
    text: 'відповідь у два рядки',
  });
  expect(new Date(incoming[0]!.at).getHours()).toBe(15);
  expect(new Date(incoming[0]!.at).getMinutes()).toBe(2);
  expect(incoming[0]?.providerMessageId).toBe(
    screenMessageId('screen:380501234567', 'відповідь у два рядки', '15:02'),
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

it('detects the ChatGPT panel boundary while keeping it outside the chat column', () => {
  expect(chatColumnBounds(1280, [299, 978, 980, 1000, 1260], true)).toEqual({
    left: 299,
    right: 980,
  });
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

it('includes an anonymized real Viber chat screenshot for timestamp OCR', async () => {
  const image = await readFile(
    fileURLToPath(
      new URL('./fixtures/viber-ocr-times-live.png', import.meta.url),
    ),
  );
  expect(image.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  expect(image.readUInt32BE(16)).toBe(680);
  expect(image.readUInt32BE(20)).toBe(638);
  const ocrTsv = await readFile(
    fileURLToPath(
      new URL('./fixtures/viber-ocr-times-live.tsv', import.meta.url),
    ),
    'utf8',
  );
  const times = groupOcrLines(parseTsvWords(ocrTsv))
    .map((line) => visibleTimeText(line.text))
    .filter((time): time is string => Boolean(time));
  expect([...new Set(times)].sort()).toEqual([
    '17:12',
    '17:48',
    '17:49',
    '18:45',
    '18:59',
    '19:17',
  ]);
});

it('finds Copy in a live test Viber menu below the cursor without selecting Delete', async () => {
  const image = await readFile(
    fileURLToPath(
      new URL('./fixtures/viber-copy-menu-bottom.png', import.meta.url),
    ),
  );
  expect(image.readUInt32BE(16)).toBe(360);
  expect(image.readUInt32BE(20)).toBe(320);
  const tsv = await readFile(
    fileURLToPath(
      new URL('./fixtures/viber-copy-menu-bottom.tsv', import.meta.url),
    ),
    'utf8',
  );
  const lines = groupOcrLines(parseTsvWords(tsv));
  const point = copyMenuPoint(lines);
  expect(point).not.toBeNull();
  const screenPoint = { x: point!.x + 305, y: point!.y + 570 };
  expect(screenPoint.x).toBeGreaterThan(440);
  expect(screenPoint.x).toBeLessThan(640);
  expect(screenPoint.y).toBeGreaterThan(620);
  expect(screenPoint.y).toBeLessThan(700);
  expect(lines.some((line) => line.text.includes('Copy message'))).toBe(true);
  expect(lines.some((line) => line.text.includes('Delete for myself'))).toBe(
    true,
  );
  expect(copyMenuSearchRegion(440, 620, 1280, 900)).toMatchObject({
    left: 90,
    top: 270,
    width: 700,
    height: 630,
  });
});

it('keeps colored footer ink outside the timestamp-bearing outgoing chat slice', () => {
  const image = syntheticBubblePixels();
  image.pixels.set([117, 71, 174], (400 * image.width + 600) * 3);
  const regions = messageBubbleRegions(
    image.pixels,
    image.width,
    image.height,
    { left: 20, right: 620 },
    110,
  ).filter((region) => region.outgoingColor);
  expect(regions.at(-1)?.top).toBe(400);
  const lines = [
    { text: 'New message', left: 335, top: 325, right: 450 },
    { text: '12:30', left: 400, top: 352, right: 440 },
  ];
  const visible = regions
    .map((region) => ({ ...region, ...outgoingBubbleText(lines, region) }))
    .filter((bubble) => bubble.messageTime);
  expect(
    visible.map(({ top, text, messageTime }) => ({ top, text, messageTime })),
  ).toEqual([{ top: 310, text: 'New message', messageTime: '12:30' }]);
});

it('opens only a unique exact My Notes entry in the own-profile menu', () => {
  const menu = { text: 'My Notes', left: 73, top: 355, right: 137 };
  expect(myNotesMenuPoint([menu], 1280, 900)).toEqual({ x: 105, y: 365 });
  expect(
    myNotesMenuPoint([{ ...menu, text: 'My Notes and more' }], 1280, 900),
  ).toBeNull();
  expect(
    myNotesMenuPoint([{ ...menu, left: 375, right: 450, top: 60 }], 1280, 900),
  ).toBeNull();
  expect(myNotesMenuPoint([menu, { ...menu, top: 480 }], 1280, 900)).toBeNull();
  expect(myNotesMenuPoint([], 1280, 900)).toBeNull();
});

it('derives the ChatGPT divider from the observed sidebar header when it is left of 74 percent', () => {
  const separators = [300, 520, 852, 868, 1000];
  const word = { text: 'ChatGPT', left: 932, top: 33 };
  expect(chatgptPanelHeader([word], 1280, 900, separators)).toEqual(word);
  for (const text of ['chatept', 'CchatGpt'])
    expect(
      chatgptPanelHeader([{ ...word, text }], 1280, 900, separators)?.text,
    ).toBe(text);
  expect(
    chatgptPanelHeader([{ ...word, text: 'ChatGPxx' }], 1280, 900, separators),
  ).toBeUndefined();
  expect(chatColumnBounds(1280, separators, true, word.left)).toEqual({
    left: 300,
    right: 868,
  });
  expect(
    chatgptPanelHeader([{ ...word, top: 13 }], 1280, 900, separators),
  ).toBeUndefined();
  expect(
    chatgptPanelHeader([{ ...word, top: 300 }], 1280, 900, separators),
  ).toBeUndefined();
  expect(chatgptPanelHeader([word], 1280, 900, [300])).toBeUndefined();
});

it('recognizes the canonical My Notes header despite a leading OCR icon', () => {
  expect(isMyNotesTitle('© My Notes')).toBe(true);
  expect(isMyNotesTitle('My Notes')).toBe(true);
  expect(isMyNotesTitle('Мої нотатки')).toBe(true);
  expect(isMyNotesTitle('My Notes junk')).toBe(false);
  expect(isMyNotesTitle('My Notes 123')).toBe(false);
});

it('recognizes My Notes from adjacent raw header words despite tall-avatar OCR grouping', () => {
  const words = [
    { text: 'о', left: 317, top: 53, width: 46, height: 46 },
    { text: 'My', left: 378, top: 69, width: 24, height: 18 },
    { text: 'Notes', left: 409, top: 69, width: 50, height: 14 },
    { text: 'Qo', left: 794, top: 66, width: 56, height: 20 },
  ];
  const bounds = { left: 300, right: 868 };
  expect(hasMyNotesHeader(words, bounds)).toBe(true);
  expect(
    hasMyNotesHeader(
      words.map((word) => ({ ...word, top: word.top + 200 })),
      bounds,
    ),
  ).toBe(false);
  expect(
    hasMyNotesHeader(
      words.map((word) => ({ ...word, left: word.left - 300 })),
      bounds,
    ),
  ).toBe(false);
  expect(
    hasMyNotesHeader(
      words.map((word) =>
        word.text === 'Notes' ? { ...word, text: 'Contacts' } : word,
      ),
      bounds,
    ),
  ).toBe(false);
  expect(
    hasMyNotesHeader(
      words.map((word) =>
        word.text === 'Notes' ? { ...word, top: 40 } : word,
      ),
      bounds,
    ),
  ).toBe(false);
  expect(
    hasMyNotesHeader(
      words.map((word) =>
        word.text === 'Notes' ? { ...word, left: 600 } : word,
      ),
      bounds,
    ),
  ).toBe(false);
});

it('uses the complete pixel banner boundary for clipped giant messages even when OCR misses it', () => {
  const width = 1280,
    height = 900,
    bounds = { left: 300, right: 868 };
  const pixels = new Uint8Array(width * height * 3);
  const paint = (
    left: number,
    top: number,
    right: number,
    bottom: number,
    color: number[],
  ) => {
    for (let y = top; y < bottom; y++)
      for (let x = left; x < right; x++) pixels.set(color, (y * width + x) * 3);
  };
  for (const bannerEnd of [112, 164, 202, 242]) {
    paint(0, 0, width, height, [239, 242, 247]);
    paint(300, 0, 868, 112, [255, 255, 255]);
    if (bannerEnd > 112) paint(300, 112, 868, bannerEnd, [48, 32, 128]);
    paint(468, bannerEnd, 852, 763, [117, 97, 255]);
    const top = deriveMessageBodyTop(pixels, width, height, bounds, 64);
    expect(top).toBe(bannerEnd);
    const [region] = messageBubbleRegions(
      pixels,
      width,
      height,
      bounds,
      top,
      850,
    ).filter((region) => region.outgoingColor);
    expect(region?.top).toBe(bannerEnd);
    const text =
      'A beginning of a very long message '.repeat(10) +
      'A sufficiently long ending of that same message '.repeat(10);
    const bubble = {
      ...region!,
      text: text.slice(-150),
      messageTime: '12:30',
      status: 'sent' as const,
      clipped: region!.top <= top + 4,
    };
    const reference = new Date('2026-11-23T12:30:00');
    const before = {
      observedAt: reference.toISOString(),
      composer: '',
      bubbles: [],
    };
    const after = { ...before, bubbles: [bubble] };
    expect(bubble.clipped).toBe(true);
    expect(outgoingSliceConfirmed(text, before, after, reference)).toBe(false);
    expect(
      outgoingSliceConfirmed(
        text,
        before,
        { ...after, bubbles: [{ ...bubble, prefixText: text.slice(0, 150) }] },
        reference,
      ),
    ).toBe(true);
  }
});

it('does not accept a future payload time as message metadata', () => {
  const reference = new Date('2026-11-23T03:15:00');
  const before = {
    observedAt: reference.toISOString(),
    composer: '',
    bubbles: [],
  };
  const after = {
    ...before,
    observedAt: new Date(reference.getTime() + 1000).toISOString(),
    bubbles: [
      {
        left: 400,
        top: 300,
        right: 600,
        bottom: 360,
        side: 'right' as const,
        text: 'Expected message',
        messageTime: '12:30',
        status: 'sent' as const,
      },
    ],
  };
  expect(
    outgoingSliceConfirmed('Expected message', before, after, reference),
  ).toBe(false);
});

it('associates a transparent emoji glyph with its badge while excluding chrome and reactions', () => {
  const width = 640,
    height = 500,
    pixels = new Uint8Array(width * height * 3);
  const paint = (
    l: number,
    t: number,
    r: number,
    b: number,
    color: number[],
  ) => {
    for (let y = t; y < b; y++)
      for (let x = l; x < r; x++) pixels.set(color, (y * width + x) * 3);
  };
  paint(0, 0, width, height, [240, 242, 245]);
  paint(530, 350, 610, 376, [117, 97, 255]);
  const badge = {
    left: 530,
    top: 350,
    right: 610,
    bottom: 376,
    side: 'right' as const,
  };
  paint(0, 200, width, 225, [15, 90, 180]); // Full-width banner is not an isolated glyph.
  paint(280, 275, 360, 290, [180, 180, 180]); // Centered date.
  paint(535, 300, 550, 320, [240, 60, 70]); // Reaction on the left of the badge's body.
  paint(620, 260, 640, 330, [0, 0, 0]); // Profile card is outside the chat badge.
  expect(unfilledEmojiBody(pixels, width, height, badge, 250)).toBeNull();
  paint(560, 290, 590, 294, [0, 0, 0]);
  paint(560, 341, 590, 345, [0, 0, 0]);
  paint(560, 290, 564, 345, [0, 0, 0]);
  paint(586, 290, 590, 345, [0, 0, 0]);
  const body = unfilledEmojiBody(pixels, width, height, badge, 250)!;
  expect(body).toEqual({ left: 560, top: 290, right: 590, bottom: 345 });
  expect(
    bubbleContentSignature(pixels, width, height, {
      ...badge,
      top: body.top,
      unfilled: true,
      bodyRegion: body,
    }),
  ).toHaveLength(384);
});

it('bounds own-profile menu OCR to the left column before locating My Notes', () => {
  const words = [
    { text: 'My', left: 73, top: 355, width: 19, height: 13 },
    { text: 'Notes', left: 98, top: 355, width: 39, height: 10 },
    {
      text: 'A giant chat line at the same height',
      left: 520,
      top: 355,
      width: 300,
      height: 14,
    },
  ];
  expect(myNotesMenuPoint(groupOcrLines(words), 1280, 900)).toBeNull();
  expect(
    myNotesMenuPoint(
      groupOcrLinesWithinBounds(words, { left: 0, right: 300 }),
      1280,
      900,
    ),
  ).toEqual({ x: 105, y: 365 });
});
