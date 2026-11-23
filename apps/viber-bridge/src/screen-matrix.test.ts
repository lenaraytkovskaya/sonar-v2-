import { describe, expect, it } from 'vitest';
import {
  SEND_TEXT_SIMILARITY,
  textSimilarity,
  chatBodyTop,
  bubbleContentSignature,
  classifyViberModal,
  matchesOutgoingText,
  messageBubbleRegions,
  outgoingBubbleStatus,
  outgoingBubbleText,
  outgoingSliceConfirmed,
  safeLayoutClick,
  type ChatSlice,
  type OutgoingBubble,
} from './screen.js';

type Color = readonly [number, number, number];
type Line = { text: string; left: number; top: number; right: number };
type Mark = 'single' | 'double' | 'blue' | 'clock' | 'failed' | 'absent';
const start = new Date('2026-11-23T12:30:00');
const slice = (bubbles: OutgoingBubble[], composer = ''): ChatSlice => ({
  observedAt: new Date(start.getTime() + 1_000).toISOString(),
  composer,
  bubbles,
});

/** RGB screenshot and separately positioned OCR output, with status glyphs drawn as pixels. */
function frame(
  rows: string[],
  mark: Mark = 'single',
  panel = true,
  banners = 0,
) {
  const width = 1280,
    height = 900,
    bounds = { left: 300, right: panel ? 868 : width };
  const pixels = new Uint8Array(width * height * 3);
  const paint = (
    left: number,
    top: number,
    right: number,
    bottom: number,
    color: Color,
  ) => {
    for (let y = top; y < bottom; y++)
      for (let x = left; x < right; x++) pixels.set(color, (y * width + x) * 3);
  };
  paint(0, 0, width, height, [239, 242, 247]);
  paint(0, 0, bounds.left, height, [255, 255, 255]);
  if (panel) paint(bounds.right, 0, width, height, [215, 220, 228]);
  const lines: Line[] = [{ text: 'Unknown', left: 324, top: 24, right: 410 }];
  paint(bounds.right - 150, 18, bounds.right - 20, 50, [117, 71, 174]); // Viber Out button.
  for (let i = 0; i < banners; i++) {
    paint(bounds.left, 64 + i * 24, bounds.right, 88 + i * 24, [117, 71, 174]);
    lines.push({
      text: 'Not in your contacts',
      left: 324,
      top: 66 + i * 24,
      right: 550,
    });
  }
  const bodyTop = chatBodyTop(lines, banners ? 64 + banners * 24 : 0);
  const center = Math.round((bounds.left + bounds.right) / 2);
  paint(center - 40, bodyTop + 20, center + 40, bodyTop + 40, [200, 200, 200]); // Date pill.
  lines.push({
    text: 'Today',
    left: center - 24,
    top: bodyTop + 22,
    right: center + 24,
  });
  paint(bounds.left + 20, 720, bounds.left + 40, 738, [230, 90, 110]); // Heart reaction.
  if (!rows.length)
    return { width, height, bounds, bodyTop, pixels, lines, paint };
  const right = bounds.right - 24,
    bottom = 760;
  const boxWidth = Math.max(
    90,
    Math.min(400, Math.max(...rows.map((row) => row.length)) * 8 + 70),
  );
  const left = right - boxWidth,
    top = bottom - rows.length * 22 - 36;
  paint(left, Math.max(bodyTop, top), right, bottom, [117, 71, 174]);
  rows.forEach((text, i) => {
    const y = top + 9 + i * 22;
    if (y < bodyTop) return;
    lines.push({
      text,
      left: left + 10,
      top: y,
      right: Math.min(right - 10, left + 10 + text.length * 7),
    });
    // Sparse ink leaves a connected bubble fill, as antialiased text does.
    for (
      let x = left + 10;
      x < Math.min(right - 10, left + 10 + text.length * 7);
      x += 7
    )
      paint(x, y, x + 2, y + 7, [250, 250, 250]);
  });
  const time = {
    text: '12:30',
    left: right - 70,
    top: bottom - 18,
    right: right - 36,
  };
  lines.push(time);
  const color: Color = mark === 'blue' ? [80, 190, 255] : [205, 205, 205];
  const tick = (x: number) => {
    for (let i = 0; i < 4; i++)
      paint(x + i, time.top + 6 + i, x + i + 2, time.top + 8 + i, color);
    for (let i = 0; i < 8; i++)
      paint(x + 3 + i, time.top + 9 - i, x + 5 + i, time.top + 11 - i, color);
  };
  if (['single', 'double', 'blue'].includes(mark)) tick(time.right + 4);
  if (['double', 'blue'].includes(mark)) tick(time.right + 18);
  if (mark === 'clock' || mark === 'failed') {
    const tint: Color = mark === 'failed' ? [240, 50, 60] : color;
    for (let y = -5; y <= 5; y++)
      for (let x = -5; x <= 5; x++)
        if (Math.abs(x * x + y * y - 25) < 7)
          paint(
            time.right + 11 + x,
            time.top + 7 + y,
            time.right + 12 + x,
            time.top + 8 + y,
            tint,
          );
  }
  return { width, height, bounds, bodyTop, pixels, lines, paint };
}

function readFrame(image: ReturnType<typeof frame>): OutgoingBubble[] {
  return messageBubbleRegions(
    image.pixels,
    image.width,
    image.height,
    image.bounds,
    image.bodyTop,
  )
    .filter((region) => region.side === 'right')
    .map((region) => {
      const { text, messageTime, timestamp } = outgoingBubbleText(
        image.lines,
        region,
      );
      return {
        ...region,
        text,
        messageTime,
        clipped: region.top <= image.bodyTop + 4,
        status: outgoingBubbleStatus(
          image.pixels,
          image.width,
          image.height,
          region,
          timestamp,
        ),
      };
    });
}

const messages: [string, string[]][] = [
  ['one character', ['я']],
  ['three letters', ['cat']],
  [
    'long row',
    [
      'An unusually long outgoing message with enough words to span the entire bubble',
    ],
  ],
  ['emoji', ['🙂']],
  ['Cyrillic', ['Привіт, перевіряємо доставку']],
  ['Latin', ['Hello from Sonar']],
  ['mixed scripts', ['Привіт Sonar 2026']],
  ['digits and time', ['1234567890 12:30']],
  ['only a time as content', ['12:30']],
  ['whitespace', ['Hello   world', '  again  ']],
  ...Array.from({ length: 9 }, (_, i): [string, string[]] => [
    `${i + 2} lines`,
    Array.from(
      { length: i + 2 },
      (_, row) => `Line ${row + 1}: змішаний content`,
    ),
  ]),
];

describe('generated Viber screenshot matrix', () => {
  it.each(messages)(
    'confirms %s from the detected bubble, OCR and pixel tick',
    (_, rows) => {
      const bubbles = readFrame(frame(rows));
      expect(bubbles).toHaveLength(1);
      expect(bubbles[0]?.messageTime).toBe('12:30');
      expect(
        outgoingSliceConfirmed(
          rows.join('\n'),
          slice([]),
          slice(bubbles),
          start,
        ),
      ).toBe(true);
    },
  );

  it.each<[Mark, OutgoingBubble['status']]>([
    ['single', 'sent'],
    ['double', 'sent'],
    ['blue', 'sent'],
    ['clock', 'pending'],
    ['failed', 'failed'],
    ['absent', 'unknown'],
  ])('classifies %s pixels and gates confirmation', (mark, status) => {
    const bubbles = readFrame(frame(['Hello from Sonar'], mark));
    expect(bubbles[0]?.status).toBe(status);
    expect(
      outgoingSliceConfirmed(
        'Hello from Sonar',
        slice([]),
        slice(bubbles),
        start,
      ),
    ).toBe(status === 'sent');
  });

  it.each(
    [false, true].flatMap((panel) =>
      [0, 1, 2, 3].map((banners) => [panel, banners] as const),
    ),
  )(
    'excludes banners, Unknown, Viber Out, date and heart (panel=%s, banners=%s)',
    (panel, banners) => {
      const image = frame(['ok'], 'single', panel, banners);
      expect(image.bodyTop).toBe(banners ? 80 + banners * 24 : 64);
      expect(readFrame(image).map((bubble) => bubble.text)).toEqual(['ok']);
      expect(readFrame(frame([], 'absent', panel, banners))).toEqual([]);
    },
  );

  it('matches an exact URL line among preview rows and rejects other URLs', () => {
    const bubbles = readFrame(
      frame([
        'https://example.com',
        'Example preview title',
        'A descriptive preview paragraph',
      ]),
    );
    expect(
      outgoingSliceConfirmed(
        'https://example.com',
        slice([]),
        slice(bubbles),
        start,
      ),
    ).toBe(true);
    for (const expected of [
      'https://example.co',
      'https://example.com/other',
      'https://evil.example',
    ]) {
      expect(
        outgoingSliceConfirmed(expected, slice([]), slice(bubbles), start),
      ).toBe(false);
    }
  });

  it('confirms a linkified message whose underlined text OCR cannot read', () => {
    const [bubble] = readFrame(frame(['1111 2222 3333']));
    const unreadable = {
      ...bubble!,
      text: '',
      ocrText: '',
      contentHash: 'new',
    };
    const old = {
      ...bubble!,
      text: 'older',
      ocrText: 'older',
      contentHash: 'old',
      messageTime: '12:00',
      top: 100,
      bottom: 150,
    };
    const send = (text: string, before: OutgoingBubble[]) =>
      outgoingSliceConfirmed(
        text,
        slice(before),
        slice([...before, unreadable]),
        start,
      );
    expect(send('1111 2222 3333', [])).toBe(true);
    expect(send('1111 2222 3333', [old])).toBe(true);
    // Plain words must still be read, and an unchanged bubble is no evidence.
    expect(send('hello there', [old])).toBe(false);
    expect(
      outgoingSliceConfirmed(
        '1111 2222 3333',
        slice([unreadable]),
        slice([unreadable]),
        start,
      ),
    ).toBe(false);
  });

  it('requires a new occurrence for identical ok messages in the same minute', () => {
    const image = frame(['ok']);
    const before = readFrame(image);
    expect(
      outgoingSliceConfirmed('ok', slice(before), slice(before), start),
    ).toBe(false);
    const bubble = before[0]!;
    const rowBytes = image.width * 3;
    image.pixels.copyWithin(
      (bubble.top - 80) * rowBytes,
      bubble.top * rowBytes,
      bubble.bottom * rowBytes,
    );
    image.lines.push(
      ...image.lines
        .filter((line) => line.top >= bubble.top && line.top < bubble.bottom)
        .map((line) => ({ ...line, top: line.top - 80 })),
    );
    const after = readFrame(image);
    expect(after).toHaveLength(2);
    expect(
      outgoingSliceConfirmed('ok', slice(before), slice(after), start),
    ).toBe(true);
  });

  it('finds the old latest bubble beyond a clipped older prefix before ten new rows', () => {
    const [older] = readFrame(frame(['Older outgoing paragraph']));
    const [latest] = readFrame(frame(['Old latest']));
    const rows = Array.from(
      { length: 10 },
      (_, i) => `New message line ${i + 1}`,
    );
    const [newest] = readFrame(frame(rows));
    expect(
      outgoingSliceConfirmed(
        rows.join('\n'),
        slice([older!, latest!]),
        slice([
          {
            ...older!,
            text: 'clipped OCR drift',
            ocrText: 'clipped OCR drift',
          },
          latest!,
          newest!,
        ]),
        start,
      ),
    ).toBe(true);
  });

  it('requires a third occurrence after two identical old messages', () => {
    const [bubble] = readFrame(frame(['ok']));
    const before = [
      { ...bubble!, top: 300, bottom: 357 },
      { ...bubble!, top: 400, bottom: 457 },
    ];
    expect(
      outgoingSliceConfirmed('ok', slice(before), slice(before), start),
    ).toBe(false);
    expect(
      outgoingSliceConfirmed(
        'ok',
        slice(before),
        slice([...before, { ...bubble!, top: 500, bottom: 557 }]),
        start,
      ),
    ).toBe(true);
  });

  it('does not make an unchanged old bubble new when only its OCR time is corrected', () => {
    const text =
      'An existing outgoing message with enough characters for the long-message fallback';
    const image = frame([text]);
    const [region] = readFrame(image);
    const signature = bubbleContentSignature(
      image.pixels,
      image.width,
      image.height,
      region!,
    );
    expect(signature).toHaveLength(384);
    const old = {
      ...region!,
      contentSignature: signature,
      messageTime: '12:29',
    };
    const corrected = { ...old, messageTime: '12:30' };
    expect(
      outgoingSliceConfirmed(text, slice([old]), slice([corrected]), start),
    ).toBe(false);
    const shiftedOld = { ...old, top: old.top - 80, bottom: old.bottom - 80 };
    expect(
      outgoingSliceConfirmed(
        text,
        slice([old]),
        slice([shiftedOld, corrected]),
        start,
      ),
    ).toBe(true);
  });

  it('rejects an old visible slice when the chat is scrolled away from the latest send', () => {
    const bubbles = readFrame(frame(['Historical message']));
    expect(
      outgoingSliceConfirmed(
        'New message',
        slice(bubbles),
        slice(bubbles),
        start,
      ),
    ).toBe(false);
    expect(
      outgoingSliceConfirmed(
        'Historical message',
        slice(bubbles),
        slice(bubbles, 'New message'),
        start,
      ),
    ).toBe(false);
  });

  it('matches a sufficiently long clipped suffix but rejects short or unrelated fragments', () => {
    const rows = Array.from(
      { length: 40 },
      (_, i) => `Paragraph ${i + 1}: різноманітний текст message`,
    );
    const [clipped] = readFrame(frame(rows, 'single', false));
    expect(clipped?.clipped).toBe(true);
    expect(clipped?.text).not.toBe(rows.join('\n'));
    expect(
      outgoingSliceConfirmed(
        rows.join('\n'),
        slice([]),
        slice([clipped!]),
        start,
      ),
    ).toBe(false);
    const [prefix] = readFrame(frame(rows.slice(0, 10)));
    expect(
      outgoingSliceConfirmed(
        rows.join('\n'),
        slice([]),
        slice([{ ...clipped!, prefixText: prefix!.text }]),
        start,
      ),
    ).toBe(true);
    expect(
      outgoingSliceConfirmed(
        rows.join('\n'),
        slice([]),
        slice([{ ...clipped!, prefixText: 'An unrelated prefix '.repeat(10) }]),
        start,
      ),
    ).toBe(false);
    const complete = { ...clipped!, prefixText: prefix!.text };
    const unrelatedShort = readFrame(frame(['🙂']));
    expect(
      outgoingSliceConfirmed(
        rows.join('\n'),
        slice(unrelatedShort),
        slice([complete]),
        start,
      ),
    ).toBe(true);
    expect(
      outgoingSliceConfirmed(
        rows.join('\n'),
        slice([complete]),
        slice([complete]),
        start,
      ),
    ).toBe(false);
    expect(matchesOutgoingText(rows.join('\n'), 'message', true)).toBe(false);
    expect(
      matchesOutgoingText(rows.join('\n'), 'Unrelated text '.repeat(20), true),
    ).toBe(false);
  });

  it('keeps an old clipped giant as an anchor when a new short bubble reduces its visible tail', () => {
    const full = Array.from(
      { length: 60 },
      (_, i) => `Paragraph ${i + 1}: content of an extremely long message`,
    ).join('\n');
    const [pixels] = readFrame(frame(full.split('\n'), 'single', false));
    const old = {
      ...pixels!,
      text: full.slice(-700),
      ocrText: full.slice(-700),
      clipped: true,
      prefixText: full.slice(0, 200),
    };
    const shrunk = {
      ...old,
      bottom: old.bottom - 80,
      text: full.slice(-400),
      ocrText: full.slice(-400),
    };
    const [newShort] = readFrame(frame(['ok'], 'single', false));
    expect(
      outgoingSliceConfirmed(
        'ok',
        slice([old]),
        slice([shrunk, newShort!]),
        start,
      ),
    ).toBe(true);
    expect(
      outgoingSliceConfirmed(full, slice([old]), slice([shrunk]), start),
    ).toBe(false);
    expect(
      outgoingSliceConfirmed('ok', slice([old]), slice([shrunk]), start),
    ).toBe(false);
    expect(
      outgoingSliceConfirmed(
        'ok',
        slice([old]),
        slice([shrunk, { ...newShort!, text: 'no' }]),
        start,
      ),
    ).toBe(false);
  });

  it.each([
    ['я', 'ю'],
    ['cat', 'car'],
    ['🙂', '🙃'],
    ['🙂', ''],
    ['ok', 'OK!'],
  ])(
    'rejects an inexact short or emoji message %s / %s',
    (expected, actual) => {
      expect(matchesOutgoingText(expected, actual)).toBe(false);
    },
  );

  it.each([
    ['No connectivity', 'unknown'],
    ['Sync chat history', 'sync_history'],
    ['Syncing canceled. Chat history will not be synced', 'sync_canceled'],
    ['Something went wrong. Fix now', 'repair'],
    ['Warning: account needs confirmation', 'unknown'],
  ])(
    'recognizes blocked screen %s and guards its action area',
    (text, modal) => {
      expect(classifyViberModal(text)).toBe(modal);
      const dialog = { left: 420, top: 280, right: 850, bottom: 600 };
      expect(safeLayoutClick(630, 550, [dialog])).toBe(false);
    },
  );
});

it('accepts OCR at the configured similarity boundary and rejects below it', () => {
  expect(textSimilarity('abcdefghij', 'abcdefghiX')).toBe(SEND_TEXT_SIMILARITY);
  expect(matchesOutgoingText('abcdefghij', 'abcdefghiX')).toBe(true);
  expect(matchesOutgoingText('abcdefghij', 'abcdefghXY')).toBe(false);
  expect(matchesOutgoingText('abcd', 'abce')).toBe(false);
  expect(matchesOutgoingText('hello 😀', 'hello 😡')).toBe(false);
});
