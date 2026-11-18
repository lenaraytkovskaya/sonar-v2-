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

function bestContainedSimilarity(expected: string, observed: string) {
  const target = normalizeOcr(expected);
  const source = normalizeOcr(observed);
  if (!target || !source) return target === source ? 1 : 0;
  const min = Math.max(1, Math.floor(target.length * 0.8));
  const max = Math.min(source.length, Math.ceil(target.length * 1.2));
  let best = 0;
  for (let size = min; size <= max; size++)
    for (let start = 0; start + size <= source.length; start++)
      best = Math.max(
        best,
        textSimilarity(target, source.slice(start, start + size)),
      );
  return best;
}

export function outgoingScreenConfirmed(
  expected: string,
  composer: string,
  outgoingBubble: string,
  messageTime?: string,
  startedAt?: Date,
) {
  void composer;
  const prefix = Array.from(expected.trim()).slice(0, 60).join('');
  const timeMatches =
    !messageTime || !startedAt || messageTimeAtOrAfter(messageTime, startedAt);
  return timeMatches && bestContainedSimilarity(prefix, outgoingBubble) >= 0.8;
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
  const body = lines.filter(
    (line) =>
      line.top > input.headerBottom &&
      line.top < input.height - 90 &&
      line.left >= input.left &&
      line.left < central &&
      line.right <= input.right,
  );
  const result: {
    from: string;
    text: string;
    at: string;
    threadId: string;
    providerMessageId: string;
  }[] = [];
  let previousTimeIndex = -1;
  for (let index = 0; index < body.length; index++) {
    const visibleTime = body[index]!.text.match(
      /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/,
    )?.[0];
    if (!visibleTime) continue;
    const at = visibleMessageTimestamp(
      visibleTime,
      input.reference ?? new Date(),
    );
    const start = Math.max(previousTimeIndex + 1, index - 5);
    const text = body
      .slice(start, index)
      .map((line) => line.text)
      .filter((line) => !/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/.test(line))
      .join(' ')
      .trim();
    previousTimeIndex = index;
    if (!at || at < input.since || !text) continue;
    result.push({
      from: input.from,
      text,
      at: at.toISOString(),
      threadId: input.threadId,
      providerMessageId: screenMessageId(input.threadId, text, visibleTime),
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
};

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
        const side =
          minX <= bounds.left + chatWidth * 0.2
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

export function inboundBubbleMessage(
  lines: readonly { text: string; left: number; top: number; right: number }[],
  input: {
    threadId: string;
    from: string;
    since: Date;
    reference: Date;
    region: BubbleRegion;
  },
) {
  if (input.region.side !== 'left') return null;
  const ordered = [...lines].sort((a, b) => a.top - b.top || a.left - b.left);
  const timeLine = [...ordered]
    .reverse()
    .find((line) => /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/.test(line.text));
  if (!timeLine) return null;
  const visibleTime = timeLine.text.match(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/)![0];
  const at = visibleMessageTimestamp(visibleTime, input.reference);
  const text = ordered
    .filter(
      (line) =>
        line !== timeLine && !/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/.test(line.text),
    )
    .map((line) => line.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!at || at <= input.since || !text) return null;
  const dayTime = at.toISOString().slice(0, 10);
  return {
    from: input.from,
    text,
    at: at.toISOString(),
    threadId: input.threadId,
    providerMessageId: `screen:${screenMessageId(input.threadId, text, `${dayTime} ${visibleTime}`)}`,
  };
}

export function messageTimeAtOrAfter(value: string, startedAt: Date) {
  const visible = visibleMessageTimestamp(value, startedAt);
  if (!visible) return true;
  return visible.getTime() >= Math.floor(startedAt.getTime() / 60_000) * 60_000;
}

export function visibleMessageTimestamp(value: string, reference: Date) {
  const match = value.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (!match) return null;
  const possibilities = [-1, 0, 1].map((offset) => {
    const visible = new Date(reference);
    visible.setDate(visible.getDate() + offset);
    visible.setHours(Number(match[1]), Number(match[2]), 0, 0);
    return visible.getTime();
  });
  const nearest = possibilities.sort(
    (a, b) =>
      Math.abs(a - reference.getTime()) - Math.abs(b - reference.getTime()),
  )[0]!;
  return new Date(nearest);
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
  const right = profileOpen
    ? [...boundaries]
        .reverse()
        .find((x) => x > width * 0.58 && x < width * 0.98)
    : width;
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
        x >= box.left - 8 &&
        x <= box.right + 8 &&
        y >= box.top - 8 &&
        y <= box.bottom + 8,
    )
  );
}

export function screenMessageId(
  threadId: string,
  text: string,
  visibleTime: string,
) {
  return createHash('sha256')
    .update([threadId, normalizeOcr(text), visibleTime].join('\n'))
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

export type ViberModal =
  'none' | 'sync_history' | 'repair' | 'close_confirmation' | 'unknown';

export function desktopPresenceState(hasProcess: boolean, hasWindow: boolean) {
  return hasProcess && hasWindow ? 'ready' : 'not_running';
}

export function classifyViberModal(text: string): ViberModal {
  const value = normalizeOcr(text);
  if (/fixnow|somethingwentwrong|repair|виправити|восстановить/.test(value))
    return 'repair';
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
