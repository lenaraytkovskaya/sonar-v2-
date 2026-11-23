import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import {
  groupOcrLines,
  bubbleContentSignature,
  similarBubbleContent,
  matchesOutgoingText,
  sameBubbleColumn,
  outgoingSliceConfirmed,
  deriveMessageBodyTop,
  unfilledEmojiBody,
  messageBubbleRegions,
  outgoingBubbleStatus,
  outgoingBubbleText,
  parseTsvWords,
} from './screen.js';

it('keeps the live long My Notes body after its footer tail disappears on scroll', async () => {
  const regions = await Promise.all(
    ['tail', 'body'].map(async (part) => {
      const pixels = gunzipSync(
        await readFile(
          new URL(`./fixtures/viber-v3-giant-${part}.rgb.gz`, import.meta.url),
        ),
      );
      return messageBubbleRegions(
        pixels,
        1280,
        900,
        { left: 300, right: 868 },
        170,
        850,
      )
        .filter((region) => region.side === 'right')
        .sort((a, b) => b.bottom - b.top - (a.bottom - a.top))[0]!;
    }),
  );
  expect(regions[0]!.right).toBe(860);
  expect(regions[1]!.right).toBe(852);
  expect(sameBubbleColumn(regions[0]!, regions[1]!)).toBe(true);
});

it('reads the full sent message and two ticks in the masked live Sonar fixture', async () => {
  // Captured 2026-11-23 in the authorized Sonar chat; sidebar is masked.
  // TSV was OCRed from the chat crop at x=300. RGB is the full 1280x900 image.
  const [rgb, tsv] = await Promise.all([
    readFile(new URL('./fixtures/viber-v3-sonar.rgb.gz', import.meta.url)),
    readFile(new URL('./fixtures/viber-v3-sonar.tsv', import.meta.url), 'utf8'),
  ]);
  const pixels = gunzipSync(rgb);
  expect(pixels.length).toBe(1280 * 900 * 3);
  const lines = groupOcrLines(
    parseTsvWords(tsv).map((word) => ({ ...word, left: word.left + 300 })),
  );
  const bubbles = messageBubbleRegions(
    pixels,
    1280,
    900,
    { left: 300, right: 1280 },
    226,
  ).filter(
    (region) =>
      region.outgoingColor && outgoingBubbleText(lines, region).messageTime,
  );
  expect(bubbles).toHaveLength(1);
  const bubble = bubbles[0]!;
  const observed = outgoingBubbleText(lines, bubble);
  expect(observed.text).toBe('V3 baseline перевірка галочок');
  expect(observed.messageTime).toBe('02:22');
  expect(
    outgoingBubbleStatus(pixels, 1280, 900, bubble, observed.timestamp),
  ).toBe('sent');
});

it('joins JPEG fill fragments and excludes footer ink without a message timestamp', async () => {
  const [rgb, tsv] = await Promise.all([
    readFile(new URL('./fixtures/viber-v3-jpeg.rgb.gz', import.meta.url)),
    readFile(
      new URL('./fixtures/viber-v3-jpeg-threshold.tsv', import.meta.url),
      'utf8',
    ),
  ]);
  const pixels = gunzipSync(rgb);
  const lines = groupOcrLines(
    parseTsvWords(tsv).map((word) => ({
      ...word,
      left: Math.round(word.left / 2) + 300,
      top: Math.round(word.top / 2),
      width: Math.round(word.width / 2),
      height: Math.round(word.height / 2),
    })),
  );
  const regions = messageBubbleRegions(
    pixels,
    1280,
    900,
    { left: 300, right: 1280 },
    226,
    850,
  ).filter((region) => region.outgoingColor);
  expect(regions.at(-1)?.top).toBeGreaterThan(800); // Purple text ink in Suggest Replies.
  const bubbles = regions
    .map((region) => ({ ...region, ...outgoingBubbleText(lines, region) }))
    .filter((bubble) => bubble.messageTime);
  expect(
    bubbles.map(({ left, top, right, bottom, messageTime }) => ({
      left,
      top,
      right,
      bottom,
      messageTime,
    })),
  ).toEqual([
    { left: 1016, top: 582, right: 1265, bottom: 641, messageTime: '02:22' },
    { left: 1185, top: 643, right: 1264, bottom: 702, messageTime: '02:31' },
    { left: 1184, top: 702, right: 1265, bottom: 763, messageTime: '02:34' },
  ]);
  for (const bubble of bubbles)
    expect(
      outgoingBubbleStatus(pixels, 1280, 900, bubble, bubble.timestamp),
    ).toBe('sent');
});

it('recognizes translated old glyphs across JPEG changes and distinguishes another character', async () => {
  const [a, b] = await Promise.all([
    readFile(new URL('./fixtures/viber-v3-jpeg.rgb.gz', import.meta.url)),
    readFile(
      new URL('./fixtures/viber-v3-jpeg-shifted.rgb.gz', import.meta.url),
    ),
  ]);
  const first = gunzipSync(a),
    second = gunzipSync(b);
  const region = (
    left: number,
    top: number,
    right: number,
    bottom: number,
  ) => ({ left, top, right, bottom, side: 'right' as const });
  const signature = (pixels: Buffer, bounds: ReturnType<typeof region>) =>
    bubbleContentSignature(pixels, 1280, 900, bounds);
  const originalYa = signature(first, region(1185, 643, 1264, 702));
  const movedYa = signature(second, region(1185, 582, 1264, 641));
  const originalZ = signature(first, region(1184, 702, 1265, 763));
  const movedZ = signature(second, region(1184, 643, 1265, 702));
  expect(similarBubbleContent(originalYa, movedYa)).toBe(true);
  expect(similarBubbleContent(originalZ, movedZ)).toBe(true);
  expect(similarBubbleContent(originalYa, movedZ)).toBe(false);
});

it('requires visible URL metadata and recovers its sent ticks after the pointer leaves the card', async () => {
  const read = async (name: string) => {
    const [rgb, tsv] = await Promise.all([
      readFile(new URL(`./fixtures/${name}.rgb.gz`, import.meta.url)),
      readFile(new URL(`./fixtures/${name}.tsv`, import.meta.url), 'utf8'),
    ]);
    const pixels = gunzipSync(rgb);
    const lines = groupOcrLines(
      parseTsvWords(tsv).map((word) => ({
        ...word,
        left: Math.round(word.left / 2) + 300,
        top: Math.round(word.top / 2),
        width: Math.round(word.width / 2),
        height: Math.round(word.height / 2),
      })),
    );
    const region = messageBubbleRegions(
      pixels,
      1280,
      900,
      { left: 300, right: 868 },
      242,
      850,
    )
      .filter((region) => region.outgoingColor)
      .find((region) =>
        outgoingBubbleText(lines, region).text.includes('https://example.com/'),
      )!;
    const message = outgoingBubbleText(lines, region);
    return {
      ...message,
      status: outgoingBubbleStatus(
        pixels,
        1280,
        900,
        region,
        message.timestamp,
      ),
    };
  };
  const hovered = await read('viber-v3-url-hover');
  expect(hovered.messageTime).toBeUndefined();
  expect(hovered.status).toBe('unknown');
  const clear = await read('viber-v3-url-clear');
  expect(clear.messageTime).toBe('02:59');
  expect(clear.status).toBe('sent');
});

it('canonicalizes a derived plain digit rendering and its real automatic underline', async () => {
  const pixels = gunzipSync(
    await readFile(
      new URL('./fixtures/viber-v3-digits.rgb.gz', import.meta.url),
    ),
  );
  const region = {
    left: 737,
    top: 643,
    right: 853,
    bottom: 702,
    side: 'right' as const,
  };
  const plain = Buffer.from(pixels);
  // Derived typography variant, not a historical before-send screenshot:
  // repaint only the observed 89-pixel underline with the bubble fill.
  for (let x = 750; x <= 838; x++)
    plain.set([117, 97, 255], (665 * 1280 + x) * 3);
  const underlined = bubbleContentSignature(pixels, 1280, 900, region);
  const unadorned = bubbleContentSignature(plain, 1280, 900, region);
  expect(similarBubbleContent(underlined, unadorned)).toBe(true);
  const line = Buffer.alloc(140 * 60 * 3);
  for (let i = 0; i < line.length; i += 3) line.set([117, 97, 255], i);
  for (let x = 16; x < 120; x++) line.set([255, 255, 255], (25 * 140 + x) * 3);
  expect(
    bubbleContentSignature(line, 140, 60, {
      left: 0,
      top: 0,
      right: 140,
      bottom: 60,
      side: 'right',
    }),
  ).not.toBe('');
});

it('requires copied evidence for an ambiguous one-letter My Notes OCR result', async () => {
  // Only the newly authorized test A and its metadata remain; all other pixels are masked.
  const [rgb, tsv] = await Promise.all([
    readFile(new URL('./fixtures/viber-v3-notes-A.rgb.gz', import.meta.url)),
    readFile(
      new URL('./fixtures/viber-v3-notes-A.tsv', import.meta.url),
      'utf8',
    ),
  ]);
  const pixels = gunzipSync(rgb);
  const lines = groupOcrLines(
    parseTsvWords(tsv).map((word) => ({
      ...word,
      left: Math.round(word.left / 2) + 745,
      top: Math.round(word.top / 2) + 510,
      width: Math.round(word.width / 2),
      height: Math.round(word.height / 2),
    })),
  );
  const [region] = messageBubbleRegions(
    pixels,
    1280,
    900,
    { left: 300, right: 868 },
    111,
    850,
  ).filter((region) => region.outgoingColor);
  const observed = outgoingBubbleText(lines, region!);
  expect(observed.text).toBe('А'); // Cyrillic OCR for a Latin A is insufficient evidence.
  expect(matchesOutgoingText('A', observed.text)).toBe(false);
  const bubble = {
    ...region!,
    ...observed,
    status: outgoingBubbleStatus(
      pixels,
      1280,
      900,
      region!,
      observed.timestamp,
    ),
  };
  expect(bubble.status).toBe('sent');
  const started = new Date('2026-11-23T03:18:00');
  const baseline = {
    observedAt: started.toISOString(),
    composer: '',
    notes: true,
    bubbles: [],
  };
  const after = {
    ...baseline,
    observedAt: new Date(started.getTime() + 1000).toISOString(),
    bubbles: [bubble],
  };
  expect(outgoingSliceConfirmed('A', baseline, after, started)).toBe(false);
  expect(
    outgoingSliceConfirmed(
      'A',
      baseline,
      { ...after, bubbles: [{ ...bubble, text: 'A', ocrText: observed.text }] },
      started,
    ),
  ).toBe(true);
});

it('excludes the full real cyan-to-purple My Notes reminder banner from message content', async () => {
  // Header/banner only: all note history and the sidebar are masked.
  const pixels = gunzipSync(
    await readFile(
      new URL('./fixtures/viber-v3-notes-banner.rgb.gz', import.meta.url),
    ),
  );
  expect(
    deriveMessageBodyTop(pixels, 1280, 900, { left: 300, right: 868 }, 64),
  ).toBe(170);
});

it('recovers the real latest My Notes footer omitted by full-window OCR', async () => {
  const [rgb, globalTsv, footerTsv] = await Promise.all([
    readFile(
      new URL('./fixtures/viber-v3-notes-footer.rgb.gz', import.meta.url),
    ),
    readFile(
      new URL('./fixtures/viber-v3-notes-footer-global.tsv', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('./fixtures/viber-v3-notes-footer.tsv', import.meta.url),
      'utf8',
    ),
  ]);
  // The RGB and global transcript are restricted to this new authorized test note.
  const pixels = gunzipSync(rgb);
  const globalLines = groupOcrLines(
    parseTsvWords(globalTsv).map((word) => ({
      ...word,
      left: Math.round(word.left / 2) + 300,
      top: Math.round(word.top / 2),
      width: Math.round(word.width / 2),
      height: Math.round(word.height / 2),
    })),
  );
  const [region] = messageBubbleRegions(
    pixels,
    1280,
    900,
    { left: 300, right: 868 },
    170,
    850,
  ).filter((region) => region.outgoingColor);
  expect(outgoingBubbleText(globalLines, region!).messageTime).toBeUndefined();
  expect(bubbleContentSignature(pixels, 1280, 900, region!)).not.toBe('');
  const [footer] = parseTsvWords(footerTsv).map((word) => ({
    ...word,
    left: Math.round(word.left / 3) + 515,
    top: Math.round(word.top / 3) + 771,
    width: Math.round(word.width / 3),
    height: Math.round(word.height / 3),
  }));
  expect(footer?.text).toBe('03:22');
  const timestamp = { ...footer!, right: footer!.left + footer!.width };
  expect(outgoingBubbleText([timestamp], region!).messageTime).toBe('03:22');
  expect(outgoingBubbleStatus(pixels, 1280, 900, region!, timestamp)).toBe(
    'sent',
  );
});

it.each([
  ['viber-v3-notes-footer', 'viber-v3-notes-cyrillic-tight', '03:22'],
  ['viber-v3-notes-latin', 'viber-v3-notes-latin-tight', '03:34'],
])(
  'reads tight black-on-white metadata for %s',
  async (image, transcript, expected) => {
    // Real 96x26 crop at747,771, resized3x, Gray55%, inverted before English digit OCR.
    const [rgb, tsv] = await Promise.all([
      readFile(new URL(`./fixtures/${image}.rgb.gz`, import.meta.url)),
      readFile(
        new URL(`./fixtures/${transcript}.tsv`, import.meta.url),
        'utf8',
      ),
    ]);
    const pixels = gunzipSync(rgb);
    const [region] = messageBubbleRegions(
      pixels,
      1280,
      900,
      { left: 300, right: 868 },
      170,
      850,
    ).filter((region) => region.outgoingColor);
    const [word] = parseTsvWords(tsv).map((word) => ({
      ...word,
      left: Math.round(word.left / 3) + 747,
      top: Math.round(word.top / 3) + 771,
      width: Math.round(word.width / 3),
      height: Math.round(word.height / 3),
    }));
    const timestamp = { ...word!, right: word!.left + word!.width };
    expect(word?.text).toBe(expected);
    expect(outgoingBubbleText([timestamp], region!).messageTime).toBe(expected);
    expect(outgoingBubbleStatus(pixels, 1280, 900, region!, timestamp)).toBe(
      'sent',
    );
  },
);

it('keeps the real unfilled emoji body and badge in stale and appended-message snapshots', async () => {
  const [rgb, tsv] = await Promise.all([
    readFile(
      new URL('./fixtures/viber-v3-unfilled-heart.rgb.gz', import.meta.url),
    ),
    readFile(
      new URL('./fixtures/viber-v3-unfilled-heart.tsv', import.meta.url),
      'utf8',
    ),
  ]);
  const pixels = gunzipSync(rgb);
  const badge = messageBubbleRegions(
    pixels,
    1280,
    900,
    { left: 300, right: 868 },
    170,
    850,
  )
    .filter((region) => region.outgoingColor)
    .at(-1);
  expect(bubbleContentSignature(pixels, 1280, 900, badge!)).toBe('');
  const body = unfilledEmojiBody(pixels, 1280, 900, badge!, 697)!;
  expect(body).toEqual({ left: 808, top: 717, right: 837, bottom: 768 });
  const [word] = parseTsvWords(tsv).map((word) => ({
    ...word,
    left: Math.round(word.left / 3) + 769,
    top: Math.round(word.top / 3) + 771,
    width: Math.round(word.width / 3),
    height: Math.round(word.height / 3),
  }));
  const timestamp = { ...word!, right: word!.left + word!.width };
  const bubble = {
    ...badge!,
    top: body.top,
    unfilled: true,
    bodyRegion: body,
    text: '□',
    ocrText: '□',
    messageTime: word!.text,
    status: outgoingBubbleStatus(pixels, 1280, 900, badge!, timestamp),
    contentSignature: '',
  };
  bubble.contentSignature = bubbleContentSignature(pixels, 1280, 900, bubble);
  expect(bubble.contentSignature).toHaveLength(384);
  expect(bubble.status).toBe('sent');
  const started = new Date('2026-11-23T03:46:00');
  const before = {
    observedAt: started.toISOString(),
    composer: '',
    notes: true,
    bubbles: [bubble],
  };
  const copied = { ...bubble, text: '💙' };
  const after = {
    ...before,
    observedAt: new Date(started.getTime() + 1000).toISOString(),
    bubbles: [copied],
  };
  expect(outgoingSliceConfirmed('💙', before, after, started)).toBe(false);
  const old = {
    ...bubble,
    top: bubble.top - 100,
    bottom: bubble.bottom - 100,
    bodyRegion: { ...body, top: body.top - 100, bottom: body.bottom - 100 },
  };
  expect(
    outgoingSliceConfirmed(
      '💙',
      before,
      { ...after, bubbles: [old, copied] },
      started,
    ),
  ).toBe(true);
});

it('matches the real clipped giant tail after regional black-on-white OCR without reducing the threshold', async () => {
  const [expected, regional] = await Promise.all([
    readFile(
      new URL('./fixtures/viber-v3-giant-expected.txt', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('./fixtures/viber-v3-giant-regional.txt', import.meta.url),
      'utf8',
    ),
  ]);
  expect(matchesOutgoingText(expected, regional, true)).toBe(true);
  expect(matchesOutgoingText(expected, regional)).toBe(false);
  // Synthetic nonempty corruption derived from the real regional transcript;
  // the historical 762-character whole-window transcript was not preserved.
  const corrupted = regional
    .split(/\s+/u)
    .map((word, index) => (index % 3 === 0 ? 'unreadable' : word))
    .join(' ');
  expect(corrupted.length).toBeGreaterThan(0);
  expect(matchesOutgoingText(expected, corrupted, true)).toBe(false);
});
