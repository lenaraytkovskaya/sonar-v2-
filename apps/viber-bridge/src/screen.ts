import { createHash } from 'node:crypto';

export function normalizeOcr(value: string) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('uk')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export function textSimilarity(left: string, right: string) {
  const a = normalizeOcr(left);
  const b = normalizeOcr(right);
  if (!a || !b) return a === b ? 1 : 0;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j]!;
      previous[j] = Math.min(
        previous[j]! + 1,
        previous[j - 1]! + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return 1 - previous[b.length]! / Math.max(a.length, b.length);
}

export function outgoingScreenConfirmed(
  expected: string,
  composer: string,
  outgoingBubble: string,
  messageTime?: string,
  startedAt?: Date,
) {
  void composer;
  const timeMatches =
    !messageTime || !startedAt || messageTimeAtOrAfter(messageTime, startedAt);
  return (
    timeMatches &&
    normalizeMessageText(expected) === normalizeMessageText(outgoingBubble)
  );
}

export function normalizeMessageText(value: string) {
  return value.replace(/\s+/gu, ' ').trim();
}

export function visibleTimeText(value: string) {
  const separated = value.match(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/)?.[0];
  if (separated) return separated;
  const compact = value.match(/\b([01]\d|2[0-3])([0-5]\d)\b/);
  return compact ? `${compact[1]}:${compact[2]}` : undefined;
}

export function visibleTimestampLine(value: string) {
  const compact = value.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');
  if (!/^(?:[01]?\d|2[0-3]):?[0-5]\d$/u.test(compact)) return undefined;
  return visibleTimeText(compact);
}

export function copyMenuPoint(
  lines: readonly { text: string; left: number; top: number; right: number }[],
) {
  const labels = [
    'copy',
    'copy message',
    'копіювати',
    'копіювати повідомлення',
    'копировать',
    'копировать сообщение',
  ].map((value) => value.toLocaleLowerCase().match(/[\p{L}]+/gu) ?? []);
  const line = lines.find((candidate) => {
    const words = candidate.text.toLocaleLowerCase().match(/[\p{L}]+/gu) ?? [];
    return labels.some((label) => {
      const actual = words.slice(-label.length);
      const prefix = words.slice(0, -label.length);
      return (
        prefix.every((word) => word.length <= 3) &&
        actual.length === label.length &&
        actual.every((word, index) => word === label[index])
      );
    });
  });
  return line
    ? {
        x: Math.round((line.left + line.right) / 2),
        y: Math.round(line.top + 10),
      }
    : null;
}

export function exactOptionPoint(
  lines: readonly { text: string; left: number; top: number; right: number }[],
  labels: readonly string[],
) {
  const normalize = (value: string) =>
    value
      .normalize('NFKC')
      .toLocaleLowerCase()
      .replace(/[\s…:]+$/u, '')
      .trim();
  const options = new Set(labels.map(normalize));
  const line = lines.find((candidate) =>
    options.has(normalize(candidate.text)),
  );
  return line
    ? {
        x: Math.round((line.left + line.right) / 2),
        y: Math.round(line.top + 10),
      }
    : null;
}

export function clipboardChanged(before: string, after: string) {
  return after.length > 0 && after !== before;
}

export function chatHeaderMatchesRecipient(header: string, phone: string) {
  const expected = phone.replace(/\D/g, '');
  return expected.length >= 7 && header.replace(/\D/g, '').includes(expected);
}

export function phoneFromOcrLines(
  lines: readonly { text: string; left: number; top: number; right: number }[],
  accept: (line: {
    text: string;
    left: number;
    top: number;
    right: number;
  }) => boolean,
) {
  for (const line of lines) {
    if (!accept(line)) continue;
    for (const candidate of line.text.match(/\+?\d[\d ()-]{6,}\d/g) ?? []) {
      const digits = candidate.replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
    }
  }
  return '';
}

export function visibleInboundMessages(
  lines: readonly { text: string; left: number; top: number; right: number }[],
  input: {
    threadId: string;
    from: string;
    since: Date;
    reference?: Date;
    left: number;
    right: number;
    headerBottom: number;
    height: number;
  },
) {
  const central = input.left + (input.right - input.left) / 2;
  const body = lines
    .filter(
      (line) =>
        line.top > input.headerBottom &&
        line.top < input.height - 90 &&
        line.left >= input.left &&
        line.left < central &&
        line.right <= input.right,
    )
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const result: {
    from: string;
    text: string;
    at: string;
    threadId: string;
    providerMessageId: string;
  }[] = [];
  const seen = new Set<string>();
  let previousTimeIndex = -1;
  for (let index = 0; index < body.length; index++) {
    const visibleTime = visibleTimeText(body[index]!.text);
    if (!visibleTime) continue;
    const reference = input.reference ?? new Date();
    const day = daySeparatorAt(lines, body[index]!.top, reference);
    if (!day) continue;
    const at = visibleMessageTimestamp(visibleTime, reference, day);
    const start = Math.max(previousTimeIndex + 1, index - 5);
    const text = body
      .slice(start, index)
      .map((line) => line.text)
      .filter(
        (line) =>
          !visibleTimeText(line) && !visibleDateSeparator(line, reference),
      )
      .join(' ')
      .trim();
    previousTimeIndex = index;
    if (!at || at < input.since || !text) continue;
    const providerMessageId = screenMessageId(
      input.threadId,
      text,
      visibleTime,
    );
    if (seen.has(providerMessageId)) continue;
    seen.add(providerMessageId);
    result.push({
      from: input.from,
      text,
      at: at.toISOString(),
      threadId: input.threadId,
      providerMessageId,
    });
  }
  return result;
}

export type BubbleRegion = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  side: 'left' | 'right' | 'center';
  daySeparator?: Date;
};

/** Viber uses a blue-violet fill for sent message bubbles. */
export function isOutgoingBubbleColor([red, green, blue]: Rgb) {
  return blue - red >= 18 && blue - green >= 18 && red - green >= -10;
}

/** Finds large, solid-color bubble backgrounds in an ImageMagick RGB crop. */
export function messageBubbleRegions(
  pixels: Uint8Array,
  width: number,
  height: number,
  bounds: { left: number; right: number },
  headerBottom: number,
) {
  const colors = new Map<number, number>();
  const colorAt = (x: number, y: number) => {
    const offset = (y * width + x) * 3;
    return (
      ((pixels[offset]! >> 4) << 8) |
      ((pixels[offset + 1]! >> 4) << 4) |
      (pixels[offset + 2]! >> 4)
    );
  };
  for (let y = headerBottom; y < height - 90; y += 2)
    for (let x = bounds.left; x < bounds.right; x += 2) {
      const color = colorAt(x, y);
      colors.set(color, (colors.get(color) ?? 0) + 1);
    }
  const background = [...colors].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (background === undefined) return [] as BubbleRegion[];

  const result: BubbleRegion[] = [];
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const candidates = [...colors]
    .filter(([color, count]) => color !== background && count >= 500)
    .map(([color]) => color);
  for (const color of candidates) {
    for (let y = headerBottom; y < height - 90; y += 1) {
      for (let x = bounds.left; x < bounds.right; x += 1) {
        const start = y * width + x;
        if (visited[start] || colorAt(x, y) !== color) continue;
        let read = 0;
        let write = 0;
        queue[write++] = start;
        visited[start] = 1;
        let minX = x;
        let maxX = x;
        let minY = y;
        let maxY = y;
        while (read < write) {
          const point = queue[read++]!;
          const px = point % width;
          const py = Math.floor(point / width);
          minX = Math.min(minX, px);
          maxX = Math.max(maxX, px);
          minY = Math.min(minY, py);
          maxY = Math.max(maxY, py);
          const neighbors: readonly (readonly [number, number])[] = [
            [px - 1, py],
            [px + 1, py],
            [px, py - 1],
            [px, py + 1],
          ];
          for (const [nx, ny] of neighbors) {
            if (
              nx < bounds.left ||
              nx >= bounds.right ||
              ny < headerBottom ||
              ny >= height - 90
            )
              continue;
            const next = ny * width + nx;
            if (!visited[next] && colorAt(nx, ny) === color) {
              visited[next] = 1;
              queue[write++] = next;
            }
          }
        }
        const boxWidth = maxX - minX + 1;
        const boxHeight = maxY - minY + 1;
        if (write < 1500 || boxWidth < 100 || boxHeight < 28) continue;
        const chatWidth = bounds.right - bounds.left;
        const rgb = [
          ((color >> 8) & 15) * 17,
          ((color >> 4) & 15) * 17,
          (color & 15) * 17,
        ] as const;
        const side = isOutgoingBubbleColor(rgb)
          ? 'right'
          : minX <= bounds.left + chatWidth * 0.2
            ? 'left'
            : maxX >= bounds.right - chatWidth * 0.2
              ? 'right'
              : 'center';
        if (side === 'center') continue;
        result.push({
          left: minX,
          top: minY,
          right: maxX + 1,
          bottom: maxY + 1,
          side,
        });
      }
    }
  }
  return result
    .sort((a, b) => a.top - b.top || a.left - b.left)
    .filter(
      (region, index, all) =>
        !all
          .slice(0, index)
          .some(
            (prior) =>
              prior.left <= region.left &&
              prior.top <= region.top &&
              prior.right >= region.right &&
              prior.bottom >= region.bottom,
          ),
    );
}

/** Infers inbound bubble bounds from left-aligned OCR text and its timestamp. */
export function inboundBubbleRegionsFromOcr(
  lines: readonly { text: string; left: number; top: number; right: number }[],
  input: {
    bounds: { left: number; right: number };
    headerBottom: number;
    height: number;
    reference?: Date;
  },
): BubbleRegion[] {
  const center =
    input.bounds.left + (input.bounds.right - input.bounds.left) / 2;
  const body = [...lines]
    .filter(
      (line) =>
        line.top > input.headerBottom &&
        line.top < input.height - 90 &&
        line.left >= input.bounds.left &&
        line.left < center &&
        line.right <= center,
    )
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const regions: BubbleRegion[] = [];
  let previousTimestampIndex = -1;
  let previousDateSeparatorIndex = -1;
  for (let index = 0; index < body.length; index++) {
    if (
      visibleDateSeparator(body[index]!.text, input.reference ?? new Date())
    ) {
      previousDateSeparatorIndex = index;
      continue;
    }
    if (!visibleTimestampLine(body[index]!.text)) continue;
    const timestamp = body[index]!;
    const start = Math.max(
      previousTimestampIndex + 1,
      previousDateSeparatorIndex + 1,
      index - 5,
    );
    const messageLines = body
      .slice(start, index)
      .filter(
        (line) =>
          !visibleTimestampLine(line.text) &&
          !visibleDateSeparator(line.text, input.reference ?? new Date()) &&
          timestamp.top - line.top <= 100 &&
          line.text.trim().length > 0,
      );
    previousTimestampIndex = index;
    if (messageLines.length === 0) continue;
    const region = {
      left: Math.max(
        input.bounds.left,
        Math.min(...messageLines.map((line) => line.left)) - 14,
      ),
      top: Math.max(
        input.headerBottom,
        Math.min(...messageLines.map((line) => line.top)) - 10,
      ),
      right: Math.min(
        center,
        Math.max(timestamp.right, ...messageLines.map((line) => line.right)) +
          14,
      ),
      bottom: Math.min(input.height - 90, timestamp.top + 18),
      side: 'left' as const,
      daySeparator: daySeparatorAt(
        lines,
        timestamp.top,
        input.reference ?? new Date(),
      ),
    };
    if (region.right - region.left >= 80 && region.bottom - region.top >= 24)
      regions.push(region);
  }
  return regions;
}

export function inboundBubbleMessage(
  lines: readonly { text: string; left: number; top: number; right: number }[],
  input: {
    threadId: string;
    from: string;
    since: Date;
    reference: Date;
    region: BubbleRegion;
    copiedText?: string;
    dedupeText?: string;
    daySeparator?: Date;
  },
) {
  if (input.region.side !== 'left') return null;
  const ordered = [...lines].sort((a, b) => a.top - b.top || a.left - b.left);
  const timeLine = [...ordered]
    .reverse()
    .find((line) => visibleTimestampLine(line.text));
  if (!timeLine) return null;
  const visibleTime = visibleTimestampLine(timeLine.text)!;
  if (!input.daySeparator) return null;
  const at = visibleMessageTimestamp(
    visibleTime,
    input.reference,
    input.daySeparator,
  );
  const text = input.copiedText ?? '';
  // Visible Viber timestamps are minute-precision; overlap the frontier minute
  // so a later message in the same minute is not silently skipped.
  if (
    !at ||
    at.getTime() < Math.floor(input.since.getTime() / 60_000) * 60_000 ||
    !normalizeMessageText(text)
  )
    return null;
  return {
    from: input.from,
    text,
    at: at.toISOString(),
    threadId: input.threadId,
    // Date inference can change when a separator becomes visible after scrolling.
    // Keep the provider ID independent of that inferred date to avoid re-imports.
    providerMessageId: `screen:${screenMessageId(input.threadId, input.dedupeText ?? text, visibleTime)}`,
  };
}

export function copyMenuSearchRegion(
  x: number,
  y: number,
  width: number,
  height: number,
  radius = 350,
) {
  const left = Math.max(0, Math.floor(x - radius));
  const top = Math.max(0, Math.floor(y - radius));
  const right = Math.min(width, Math.ceil(x + radius));
  const bottom = Math.min(height, Math.ceil(y + radius));
  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
    crop: `${right - left}x${bottom - top}+${left}+${top}`,
  };
}

export function inboundOcrFallbackText(
  lines: readonly { text: string; left: number; top: number; right: number }[],
) {
  return lines
    .filter(
      (line) =>
        !visibleTimestampLine(line.text) &&
        !/\b(?:block|report(?:\s+spam)?|spam|unblock|видалити|заблокувати|поскаржитися|спам|блокировать|пожаловаться)\b/iu.test(
          line.text,
        ),
    )
    .map((line) => line.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

const monthNumbers = new Map<string, number>([
  ['january', 0],
  ['jan', 0],
  ['січня', 0],
  ['січень', 0],
  ['января', 0],
  ['январь', 0],
  ['february', 1],
  ['feb', 1],
  ['лютого', 1],
  ['лютий', 1],
  ['февраля', 1],
  ['февраль', 1],
  ['march', 2],
  ['mar', 2],
  ['березня', 2],
  ['березень', 2],
  ['марта', 2],
  ['март', 2],
  ['april', 3],
  ['apr', 3],
  ['квітня', 3],
  ['квітень', 3],
  ['апреля', 3],
  ['апрель', 3],
  ['may', 4],
  ['травня', 4],
  ['травень', 4],
  ['мая', 4],
  ['june', 5],
  ['jun', 5],
  ['червня', 5],
  ['червень', 5],
  ['июня', 5],
  ['июнь', 5],
  ['july', 6],
  ['jul', 6],
  ['липня', 6],
  ['липень', 6],
  ['июля', 6],
  ['июль', 6],
  ['august', 7],
  ['aug', 7],
  ['серпня', 7],
  ['серпень', 7],
  ['августа', 7],
  ['август', 7],
  ['september', 8],
  ['sep', 8],
  ['вересня', 8],
  ['вересень', 8],
  ['сентября', 8],
  ['сентябрь', 8],
  ['october', 9],
  ['oct', 9],
  ['жовтня', 9],
  ['жовтень', 9],
  ['октября', 9],
  ['октябрь', 9],
  ['november', 10],
  ['nov', 10],
  ['листопада', 10],
  ['листопад', 10],
  ['ноября', 10],
  ['ноябрь', 10],
  ['december', 11],
  ['dec', 11],
  ['грудня', 11],
  ['грудень', 11],
  ['декабря', 11],
  ['декабрь', 11],
]);

/** Parses Viber's date dividers in English, Ukrainian, and Russian. */
export function visibleDateSeparator(value: string, reference: Date) {
  const normalized = value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[,.]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (/^(today|сьогодні|сегодня)$/u.test(normalized))
    return new Date(reference);
  if (/^(yesterday|вчора|вчера)$/u.test(normalized)) {
    const day = new Date(reference);
    day.setDate(day.getDate() - 1);
    return day;
  }
  const match = normalized.match(/^(\d{1,2})\s+([\p{L}]+)(?:\s+(\d{4}))?$/u);
  if (!match) return undefined;
  const month = monthNumbers.get(match[2]!);
  if (month === undefined) return undefined;
  const day = Number(match[1]);
  const years = match[3]
    ? [Number(match[3])]
    : [reference.getFullYear(), reference.getFullYear() - 1];
  const candidates = years
    .map(() => new Date(reference.getFullYear(), month, day, 0, 0, 0, 0))
    .filter((date, index) => {
      date.setFullYear(years[index]!);
      return date.getMonth() === month && date.getDate() === day;
    })
    .sort(
      (a, b) =>
        Math.abs(a.getTime() - reference.getTime()) -
        Math.abs(b.getTime() - reference.getTime()),
    );
  return candidates[0];
}

export function daySeparatorAt(
  lines: readonly { text: string; top: number }[],
  top: number,
  reference: Date,
) {
  const ordered = [...lines].sort((a, b) => a.top - b.top);
  const above = ordered
    .filter((line) => line.top < top)
    .reverse()
    .map((line) => visibleDateSeparator(line.text, reference))
    .find((date) => date !== undefined);
  if (above) return above;

  const below = ordered
    .filter((line) => line.top > top)
    .map((line) => visibleDateSeparator(line.text, reference))
    .find((date) => date !== undefined);
  if (!below) return undefined;
  // A divider below this bubble starts the next day in Viber's chronological
  // layout, so the bubble belongs to the preceding calendar day.
  below.setDate(below.getDate() - 1);
  return below;
}

export function messageTimeAtOrAfter(value: string, startedAt: Date) {
  const match = value.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (!match) return true;
  const possibilities = [-1, 0, 1].map((offset) => {
    const visible = new Date(startedAt);
    visible.setDate(visible.getDate() + offset);
    visible.setHours(Number(match[1]), Number(match[2]), 0, 0);
    return visible.getTime();
  });
  const visible = possibilities.sort(
    (a, b) =>
      Math.abs(a - startedAt.getTime()) - Math.abs(b - startedAt.getTime()),
  )[0]!;
  return visible >= Math.floor(startedAt.getTime() / 60_000) * 60_000;
}

export function visibleMessageTimestamp(
  value: string,
  reference: Date,
  daySeparator?: Date,
) {
  const match = value.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (!match) return null;
  const visible = new Date(daySeparator ?? reference);
  visible.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (daySeparator) return visible > reference ? null : visible;
  // Explicit dividers determine the day; without one use today, falling back to
  // yesterday for clock times later than the current local time.
  if (visible > reference) visible.setDate(visible.getDate() - 1);
  return visible;
}

export type Rgb = readonly [number, number, number];

/** Returns strong vertical color transitions from an ImageMagick 1px row sample. */
export function verticalColorBoundaries(samples: readonly Rgb[]) {
  const candidates: { x: number; strength: number }[] = [];
  for (let x = 1; x < samples.length; x++) {
    const previous = samples[x - 1]!;
    const current = samples[x]!;
    const strength = Math.hypot(
      current[0] - previous[0],
      current[1] - previous[1],
      current[2] - previous[2],
    );
    if (strength >= 18) candidates.push({ x, strength });
  }
  const groups: { x: number; strength: number }[] = [];
  for (const point of candidates) {
    const previous = groups.at(-1);
    if (previous && point.x - previous.x <= 3) {
      if (point.strength > previous.strength) groups[groups.length - 1] = point;
    } else groups.push(point);
  }
  return groups.map((point) => point.x);
}

export function chatColumnBounds(
  width: number,
  boundaries: readonly number[],
  profileOpen = false,
) {
  const left = boundaries.find((x) => x > width * 0.08 && x < width * 0.4);
  const panelCandidates = profileOpen
    ? boundaries.filter((x) => x > width * 0.45 && x < width * 0.98)
    : [];
  const panelBoundary = profileOpen
    ? [...panelCandidates].sort(
        (a, b) => Math.abs(a / width - 0.77) - Math.abs(b / width - 0.77),
      )[0]
    : undefined;
  const right = panelBoundary ?? width;
  return { left: left ?? 0, right: right ?? width };
}

export function safeLayoutClick(
  x: number,
  y: number,
  forbidden: readonly {
    left: number;
    top: number;
    right: number;
    bottom: number;
  }[],
) {
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    !forbidden.some(
      (box) =>
        x >= box.left - 40 &&
        x <= box.right + 40 &&
        y >= box.top - 40 &&
        y <= box.bottom + 40,
    )
  );
}

export function screenMessageId(
  threadId: string,
  text: string,
  visibleTime: string,
) {
  return createHash('sha256')
    .update([threadId, normalizeMessageText(text), visibleTime].join('\n'))
    .digest('hex');
}

export type OcrWord = {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

export function parseTsvWords(tsv: string): OcrWord[] {
  return tsv
    .split(/\r?\n/)
    .slice(1)
    .flatMap((row) => {
      const fields = row.split('\t');
      const text = fields[11]?.trim();
      const values = fields.slice(6, 10).map(Number);
      if (!text || values.some((value) => !Number.isFinite(value))) return [];
      return [
        {
          text,
          left: values[0]!,
          top: values[1]!,
          width: values[2]!,
          height: values[3]!,
        },
      ];
    });
}

export function groupOcrLines(words: OcrWord[]) {
  const groups = new Map<string, OcrWord[]>();
  for (const word of words) {
    const key = String(Math.round((word.top + word.height / 2) / 12));
    groups.set(key, [...(groups.get(key) ?? []), word]);
  }
  return [...groups.values()].map((line) => ({
    text: line
      .sort((a, b) => a.left - b.left)
      .map((word) => word.text)
      .join(' '),
    left: Math.min(...line.map((word) => word.left)),
    top: Math.min(...line.map((word) => word.top)),
    right: Math.max(...line.map((word) => word.left + word.width)),
  }));
}

export function groupOcrLinesWithinBounds(
  words: readonly OcrWord[],
  bounds: { left: number; right: number },
) {
  return groupOcrLines(
    words.filter(
      (word) =>
        word.left >= bounds.left && word.left + word.width < bounds.right,
    ),
  );
}

export type ViberModal =
  | 'none'
  | 'sync_history'
  | 'sync_canceled'
  | 'repair'
  | 'close_confirmation'
  | 'unknown';

export function desktopPresenceState(hasProcess: boolean, hasWindow: boolean) {
  return hasProcess && hasWindow ? 'ready' : 'not_running';
}

export function classifyViberModal(text: string): ViberModal {
  const value = normalizeOcr(text);
  if (/fixnow|somethingwentwrong|repair|виправити|восстановить/.test(value))
    return 'repair';
  if (
    /syncingcanceled|chathistorywillnotbesynced|синхронізаціюскасовано/.test(
      value,
    )
  )
    return 'sync_canceled';
  if (/leavingsosoon/.test(value)) return 'close_confirmation';
  if (
    /synchistory|syncchathistory|синхронізаціячатів|синхронизацияистории/.test(
      value,
    )
  )
    return 'sync_history';
  if (/dialog|modal|error|warning|помилка|попередження/.test(value))
    return 'unknown';
  return 'none';
}

export function screenClickPoint(
  x: number,
  y: number,
  width: number,
  height: number,
) {
  if (
    ![x, y, width, height].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0 ||
    x < 0 ||
    y < 0 ||
    x > width ||
    y > height
  )
    throw Error('invalid_click');
  return {
    x: Math.min(1279, Math.round((x / width) * 1280)),
    y: Math.min(899, Math.round((y / height) * 900)),
  };
}
