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

export const SEND_TEXT_SIMILARITY = 0.9;
export type OutgoingBubble = BubbleRegion & {
  text: string;
  messageTime?: string;
  status: 'sent' | 'pending' | 'failed' | 'unknown';
  clipped?: boolean;
  contentHash?: string;
  contentSignature?: string;
  ocrText?: string;
  prefixText?: string;
};
export type ChatSlice = {
  observedAt: string;
  composer: string;
  bubbles: OutgoingBubble[];
  notes?: boolean;
};

export function sameBubbleColumn(
  a: Pick<BubbleRegion, 'left' | 'right'>,
  b: Pick<BubbleRegion, 'left' | 'right'>,
) {
  // The footer tail protrudes to the right; the body keeps its left edge.
  return (
    Math.abs(a.left - b.left) < 6 &&
    Math.abs(a.right - a.left - (b.right - b.left)) < 12
  );
}

export function matchesOutgoingText(
  expected: string,
  actual: string,
  clipped = false,
) {
  const exact = normalizeMessageText(expected)
    .normalize('NFKC')
    .toLocaleLowerCase();
  const observed = normalizeMessageText(actual)
    .normalize('NFKC')
    .toLocaleLowerCase();
  if (!exact || !observed) return false;
  if (exact === observed) return true;
  // A link card adds its own title/description. Require the entire expected URL
  // on its own body line, so another domain or preview substring cannot match.
  if (/^https?:\/\/\S+$/iu.test(exact))
    return actual
      .split(/\r?\n/u)
      .some(
        (line) =>
          normalizeMessageText(line).normalize('NFKC').toLocaleLowerCase() ===
          exact,
      );
  const emoji = (value: string) =>
    (
      value.match(
        /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}]/gu,
      ) ?? []
    ).join('');
  if (emoji(expected) !== emoji(actual)) return false;
  const a = normalizeOcr(expected),
    b = normalizeOcr(actual);
  // OCR cannot reliably distinguish a different short word or an emoji.
  if (a.length <= 4 || !b) return false;
  if (clipped && a.length > 160 && b.length >= 80 && b.length < a.length)
    return textSimilarity(a.slice(-b.length), b) >= SEND_TEXT_SIMILARITY;
  return textSimilarity(a, b) >= SEND_TEXT_SIMILARITY;
}

/** Viber underlines phone numbers, URLs and e-mails; OCR often reads nothing from that text. */
export function unreadableLink(expected: string, seen: string) {
  return (
    /\d[\d\s().-]{5,}\d|https?:\/\/|www\.|\S+@\S+\.[a-z]{2,}|\b[a-z0-9-]+\.[a-z]{2,}\b/iu.test(
      expected,
    ) && normalizeOcr(seen).length < normalizeOcr(expected).length * 0.4
  );
}

export function outgoingSliceConfirmed(
  expected: string,
  before: ChatSlice,
  after: ChatSlice,
  startedAt: Date,
) {
  if (
    !Number.isFinite(Date.parse(after.observedAt)) ||
    Date.parse(after.observedAt) < startedAt.getTime()
  )
    return false;
  const newest = after.bubbles.at(-1);
  const observedAt = new Date(after.observedAt);
  const messageAt =
    newest?.messageTime &&
    visibleMessageTimestamp(newest.messageTime, observedAt);
  if (
    !messageAt ||
    messageAt.getTime() < Math.floor(startedAt.getTime() / 60_000) * 60_000
  )
    return false;
  if (
    !newest ||
    !newest.messageTime ||
    !messageTimeAtOrAfter(newest.messageTime, startedAt) ||
    !(
      newest.status === 'sent' ||
      (after.notes && newest.status === 'unknown')
    ) ||
    !(
      matchesOutgoingText(expected, newest.text, newest.clipped) ||
      unreadableLink(expected, newest.text)
    ) ||
    (newest.clipped &&
      (!newest.prefixText ||
        !matchesOutgoingText(
          normalizeOcr(expected).slice(0, 80),
          normalizeOcr(newest.prefixText).slice(0, 80),
        )))
  )
    return false;
  const sameContent = (a: OutgoingBubble, b: OutgoingBubble) =>
    (!!a.contentHash && a.contentHash === b.contentHash) ||
    (Math.abs(a.right - a.left - (b.right - b.left)) <= 4 &&
      Math.abs(a.bottom - a.top - (b.bottom - b.top)) <= 4 &&
      similarBubbleContent(a.contentSignature, b.contentSignature)) ||
    matchesOutgoingText(
      a.ocrText ?? a.text,
      b.ocrText ?? b.text,
      a.clipped && b.clipped,
    );
  const same = (a: OutgoingBubble, b: OutgoingBubble) =>
    a.messageTime === b.messageTime && sameContent(a, b);
  // Retain an overlapping ordered suffix as the chat scrolls. An unchanged old
  // bubble, including an identical send in the same minute, is never new evidence.
  for (
    let overlap = Math.min(before.bubbles.length, after.bubbles.length);
    overlap > 0;
    overlap--
  ) {
    for (let start = 0; start <= after.bubbles.length - overlap; start++) {
      if (
        before.bubbles
          .slice(-overlap)
          .every((bubble, i) => same(bubble, after.bubbles[start + i]!))
      )
        return start + overlap < after.bubbles.length;
    }
  }
  // Correcting only the OCR footer cannot turn an unchanged old body into a send.
  if (
    before.bubbles.some(
      (bubble) =>
        Math.abs(bubble.bottom - newest.bottom) <= 4 &&
        Math.abs(bubble.right - newest.right) <= 4 &&
        sameContent(bubble, newest),
    )
  )
    return false;
  return (
    before.bubbles.length === 0 ||
    ((normalizeOcr(newest.ocrText ?? newest.text).length > 4 ||
      unreadableLink(expected, newest.ocrText ?? newest.text)) &&
      before.bubbles.every((bubble) => !same(bubble, newest)))
  );
}

export function chatBodyTop(
  lines: readonly { text: string; top: number }[],
  bannerBottom = 0,
) {
  return Math.max(
    64,
    bannerBottom + (bannerBottom ? 16 : 0),
    ...lines.filter((line) => line.top < 58).map((line) => line.top + 28),
  );
}

/** Full-width contact/reminder banners remain chrome even when OCR misses their rows. */
export function deriveMessageBodyTop(
  pixels: Uint8Array,
  width: number,
  height: number,
  bounds: { left: number; right: number },
  headerBottom: number,
) {
  let bannerBottom = 0,
    headerEnd = 0;
  const step = Math.max(1, Math.floor((bounds.right - bounds.left) / 160));
  const chromeColor = (r: number, g: number, b: number) =>
    Math.max(r, g, b) - Math.min(r, g, b) >= 40;
  const coloredEdge = (x: number, y: number) => {
    const i = (y * width + x) * 3;
    return chromeColor(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
  };
  for (let y = 0; y < Math.min(height - 90, Math.floor(height * 0.4)); y++) {
    let colored = 0,
      white = 0,
      count = 0;
    for (let x = bounds.left + 2; x < bounds.right - 2; x += step) {
      const i = (y * width + x) * 3,
        r = pixels[i]!,
        g = pixels[i + 1]!,
        b = pixels[i + 2]!;
      count++;
      if (chromeColor(r, g, b)) colored++;
      if (Math.min(r, g, b) > 247 && Math.max(r, g, b) - Math.min(r, g, b) < 10)
        white++;
    }
    if (
      colored / count >= 0.7 &&
      coloredEdge(bounds.left + 2, y) &&
      coloredEdge(bounds.right - 3, y)
    )
      bannerBottom = y + 1;
    else if (!bannerBottom && y < height * 0.16 && white / count >= 0.85)
      headerEnd = y + 1;
  }
  return bannerBottom || Math.max(headerBottom, headerEnd);
}

export function outgoingBubbleText(
  lines: readonly { text: string; left: number; top: number; right: number }[],
  region: BubbleRegion,
) {
  const inside = lines
    .filter(
      (line) =>
        line.left >= region.left - 2 &&
        line.right <= region.right + 3 &&
        line.top >= region.top &&
        line.top < region.bottom + 22,
    )
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const timestamp = [...inside]
    .reverse()
    .find(
      (line) => visibleTimeText(line.text) && line.top >= region.bottom - 36,
    );
  const body = inside.filter((line) =>
    timestamp ? line.top < region.bottom - 36 : line.top < region.bottom - 8,
  );
  return {
    text: body
      .map((line) => line.text)
      .join('\n')
      .trim(),
    messageTime: timestamp && visibleTimeText(timestamp.text),
    timestamp,
  };
}

function unfilledInk(red: number, green: number, blue: number) {
  return (
    Math.max(red, green, blue) < 95 ||
    Math.max(red, green, blue) - Math.min(red, green, blue) > 75
  );
}
/** Associates an isolated emoji glyph with its right-aligned timestamp badge. */
export function unfilledEmojiBody(
  pixels: Uint8Array,
  width: number,
  height: number,
  badge: BubbleRegion,
  above: number,
) {
  const left = Math.max(0, badge.left),
    right = Math.min(width, badge.right),
    top = Math.max(0, above),
    bottom = Math.min(height, badge.top);
  const w = right - left,
    h = bottom - top;
  if (w <= 0 || h <= 0) return null;
  const mask = new Uint8Array(w * h),
    queue = new Int32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = ((top + y) * width + left + x) * 3;
      if (unfilledInk(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!))
        mask[y * w + x] = 1;
    }
  let best:
    | { left: number; top: number; right: number; bottom: number; area: number }
    | undefined;
  for (let point = 0; point < mask.length; point++) {
    if (!mask[point]) continue;
    let read = 0,
      write = 0,
      minX = w,
      maxX = 0,
      minY = h,
      maxY = 0;
    queue[write++] = point;
    mask[point] = 0;
    while (read < write) {
      const p = queue[read++]!,
        x = p % w,
        y = Math.floor(p / w);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const n = ny * w + nx;
          if (mask[n]) {
            mask[n] = 0;
            queue[write++] = n;
          }
        }
    }
    // Wallpaper, prior bubbles and badge anti-aliasing touch the search edges.
    if (
      minX === 0 ||
      maxX === w - 1 ||
      minY === 0 ||
      maxY === h - 1 ||
      minX === maxX ||
      minY === maxY ||
      (minX + maxX + 1) / 2 < w / 2
    )
      continue;
    if (!best || write > best.area)
      best = {
        left: left + minX,
        top: top + minY,
        right: left + maxX + 1,
        bottom: top + maxY + 1,
        area: write,
      };
  }
  if (!best) return null;
  return {
    left: best.left,
    top: best.top,
    right: best.right,
    bottom: best.bottom,
  };
}

/** Normalized message ink survives JPEG noise and translation in the chat. */
export function bubbleContentSignature(
  pixels: Uint8Array,
  width: number,
  height: number,
  region: BubbleRegion,
) {
  let ink: { x: number; y: number }[] = [];
  const body = region.unfilled && region.bodyRegion ? region.bodyRegion : null;
  for (
    let y = Math.max(0, body ? body.top : region.top + 8);
    y < Math.min(height, body ? body.bottom : region.bottom - 24);
    y++
  )
    for (
      let x = Math.max(0, body ? body.left : region.left + 8);
      x < Math.min(width, body ? body.right : region.right - 8);
      x++
    ) {
      const i = (y * width + x) * 3,
        r = pixels[i]!,
        g = pixels[i + 1]!,
        b = pixels[i + 2]!;
      if (
        body
          ? unfilledInk(r, g, b)
          : Math.min(r, g) > 165 ||
            (!isOutgoingBubbleColor([r, g, b]) &&
              Math.hypot(r - 117, g - 97, b - 255) > 100)
      )
        ink.push({ x, y });
    }
  if (ink.length < 3) return '';
  const measure = () => {
    let left = width,
      right = 0,
      top = height,
      bottom = 0;
    for (const point of ink) {
      left = Math.min(left, point.x);
      right = Math.max(right, point.x + 1);
      top = Math.min(top, point.y);
      bottom = Math.max(bottom, point.y + 1);
    }
    return { left, right, top, bottom };
  };
  let { left, right, top, bottom } = measure();
  // Auto-linked phone numbers gain a long underline after rendering. Remove
  // that decoration only when several separate glyph rows remain above it.
  if (right - left >= 32) {
    const rows = new Map<number, number>();
    for (const point of ink) rows.set(point.y, (rows.get(point.y) ?? 0) + 1);
    const decoration = new Set<number>();
    for (let y = bottom - 1; y >= bottom - 2; y--) {
      if (
        (rows.get(y) ?? 0) < (right - left) * 0.8 ||
        [...rows.keys()].filter((row) => row < y).length < 3
      )
        break;
      decoration.add(y);
    }
    if (decoration.size) {
      ink = ink.filter((point) => !decoration.has(point.y));
      ({ left, right, top, bottom } = measure());
    }
  }
  const cells = new Uint32Array(24 * 16);
  for (const point of ink)
    cells[
      Math.min(15, Math.floor(((point.y - top) * 16) / (bottom - top))) * 24 +
        Math.min(23, Math.floor(((point.x - left) * 24) / (right - left)))
    ]!++;
  const area = ((right - left) * (bottom - top)) / (24 * 16);
  return [...cells]
    .map((count) => (count / Math.max(1, area) >= 0.2 ? '1' : '0'))
    .join('');
}
export function similarBubbleContent(left?: string, right?: string) {
  if (!left || !right || left.length !== right.length) return false;
  let changed = 0;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) changed++;
  return changed <= left.length * 0.12;
}

/** Status is read only beside the metadata time, never from message text. */
function classifyOutgoingBubbleStatus(
  pixels: Uint8Array,
  width: number,
  height: number,
  region: BubbleRegion,
  timeLine: { left: number; top: number; right: number } | undefined,
  antialias = false,
): OutgoingBubble['status'] {
  if (!timeLine) return 'unknown';
  const left = Math.max(
    0,
    Math.ceil(Math.min(timeLine.right, timeLine.left + 36) + 2),
  );
  const right = Math.min(width, region.right - 4, left + 36);
  const top = Math.max(0, timeLine.top - 2),
    bottom = Math.min(height, top + 21);
  if (right <= left) return 'unknown';
  const offset = (x: number, y: number) => (y * width + x) * 3;
  const base = offset(left, top);
  const background = [pixels[base]!, pixels[base + 1]!, pixels[base + 2]!];
  const points = new Set<number>();
  const support = new Set<number>();
  for (let y = top; y < bottom; y++)
    for (let x = left; x < right; x++) {
      const i = offset(x, y),
        r = pixels[i]!,
        g = pixels[i + 1]!,
        b = pixels[i + 2]!;
      if (r > 150 && r - g > 70 && r - b > 50) return 'failed';
      const distance = Math.hypot(
        r - background[0]!,
        g - background[1]!,
        b - background[2]!,
      );
      const foreground =
        Math.max(r, g, b) - Math.min(r, g, b) < 55 ||
        b > r + 35 ||
        Math.min(r, g, b) > 195;
      const dr = r - background[0]!,
        dg = g - background[1]!;
      if (
        foreground &&
        (distance > 65 ||
          (antialias &&
            distance > 65 / 2 &&
            dr * dg > 0 &&
            Math.min(Math.abs(dr), Math.abs(dg)) > 65 / 4))
      )
        support.add(y * width + x);
      if (foreground && distance > 65) points.add(y * width + x);
    }
  let pending = false,
    sent = false;
  while (points.size) {
    const seed = points.values().next().value!;
    points.delete(seed);
    support.delete(seed);
    const component = [seed];
    for (let i = 0; i < component.length; i++) {
      const point = component[i]!,
        x = point % width,
        y = Math.floor(point / width);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const next = (y + dy) * width + x + dx;
          // Strong stroke seeds retain adjacent anti-aliasing support; JPEG
          // must not disconnect the short arm from the long check stroke.
          if (support.delete(next)) {
            points.delete(next);
            component.push(next);
          }
        }
    }
    const xs = component.map((p) => p % width),
      ys = component.map((p) => Math.floor(p / width));
    const minX = Math.min(...xs),
      maxX = Math.max(...xs),
      minY = Math.min(...ys),
      maxY = Math.max(...ys);
    const w = maxX - minX + 1,
      h = maxY - minY + 1;
    // The bubble's rounded lower corner can expose wallpaper in this crop.
    // An icon is contained; a component cut by its outer edges is not an icon.
    if (maxX === right - 1 || maxY === bottom - 1) continue;
    if (component.length < 5 || w < 5 || h < 3 || w > 30 || h > 18) continue;
    const lower = (x: number) =>
      Math.max(
        ...component
          .filter((p) => p % width === x)
          .map((p) => Math.floor(p / width)),
      );
    const valley = component
      .filter((p) => Math.floor(p / width) >= maxY)
      .map((p) => p % width);
    const vx = Math.min(...valley);
    // A check descends from the short left arm, then rises along its long arm.
    if (
      vx > minX &&
      vx < maxX - 1 &&
      lower(minX) <= maxY - 1 &&
      lower(maxX) <= maxY - 3 &&
      component.some(
        (p) => p % width >= maxX - 1 && Math.floor(p / width) <= minY + 1,
      )
    )
      sent = true;
    else if (!(lower(minX) >= maxY - 1 && lower(maxX) <= minY + 1))
      pending = true;
  }
  return pending ? 'pending' : sent ? 'sent' : 'unknown';
}

export function outgoingBubbleStatus(
  pixels: Uint8Array,
  width: number,
  height: number,
  region: BubbleRegion,
  timeLine?: { left: number; top: number; right: number },
): OutgoingBubble['status'] {
  const strong = classifyOutgoingBubbleStatus(
    pixels,
    width,
    height,
    region,
    timeLine,
  );
  return strong === 'unknown'
    ? classifyOutgoingBubbleStatus(
        pixels,
        width,
        height,
        region,
        timeLine,
        true,
      )
    : strong;
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

export function isMyNotesTitle(value: string) {
  return ['mynotes', 'моїнотатки', 'моизаметки'].includes(normalizeOcr(value));
}

export function hasMyNotesHeader(
  words: readonly {
    text: string;
    left: number;
    top: number;
    width: number;
    height: number;
  }[],
  bounds: { left: number; right: number },
) {
  const header = words.filter(
    (word) =>
      word.top >= 40 &&
      word.top + word.height <= 110 &&
      word.left >= bounds.left &&
      word.left + word.width <= bounds.right,
  );
  const labels = [
    ['my', 'notes'],
    ['мої', 'нотатки'],
    ['мои', 'заметки'],
  ];
  return header.some(
    (word) =>
      isMyNotesTitle(word.text) ||
      labels.some(
        ([first, second]) =>
          normalizeOcr(word.text) === first &&
          header.some(
            (next) =>
              normalizeOcr(next.text) === second &&
              next.left >= word.left + word.width &&
              next.left - word.left - word.width <=
                Math.max(word.height, next.height) * 2 &&
              Math.abs(
                word.top + word.height / 2 - next.top - next.height / 2,
              ) <=
                Math.max(word.height, next.height) / 2,
          ),
      ),
  );
}

export function myNotesMenuPoint(
  lines: readonly { text: string; left: number; top: number; right: number }[],
  width: number,
  height: number,
) {
  const candidates = lines.filter(
    (line) =>
      line.left >= 45 &&
      line.right < width * 0.3 &&
      line.top > 50 &&
      line.top < height * 0.8 &&
      /^(?:my\s+notes|мої\s+нотатки|мои\s+заметки)$/iu.test(line.text.trim()),
  );
  return candidates.length === 1
    ? exactOptionPoint(candidates, ['My Notes', 'Мої нотатки', 'Мои заметки'])
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
  outgoingColor?: boolean;
  unfilled?: boolean;
  bodyRegion?: { left: number; top: number; right: number; bottom: number };
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
  bodyBottom = height - 90,
) {
  const colors = new Map<number, number>();
  const colorAt = (x: number, y: number) => {
    const offset = (y * width + x) * 3;
    // JPEG changes neighboring fill pixels across quantization buckets. Treat
    // the outgoing color family as one connected surface, preserving its holes.
    if (
      isOutgoingBubbleColor([
        pixels[offset]!,
        pixels[offset + 1]!,
        pixels[offset + 2]!,
      ])
    )
      return 4096;
    return (
      ((pixels[offset]! >> 4) << 8) |
      ((pixels[offset + 1]! >> 4) << 4) |
      (pixels[offset + 2]! >> 4)
    );
  };
  for (let y = headerBottom; y < bodyBottom; y += 2)
    for (let x = bounds.left; x < bounds.right; x += 2) {
      const color = colorAt(x, y);
      colors.set(color, (colors.get(color) ?? 0) + 1);
    }
  const edgeColors = new Map<number, number>();
  for (let y = headerBottom; y < bodyBottom; y += 2)
    for (const x of [bounds.left + 2, bounds.right - 3]) {
      const color = colorAt(x, y);
      edgeColors.set(color, (edgeColors.get(color) ?? 0) + 1);
    }
  const background = [...edgeColors].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (background === undefined) return [] as BubbleRegion[];

  const result: BubbleRegion[] = [];
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const outgoingColor = (color: number) =>
    color === 4096 ||
    isOutgoingBubbleColor([
      ((color >> 8) & 15) * 17,
      ((color >> 4) & 15) * 17,
      (color & 15) * 17,
    ]);
  const candidates = [...colors]
    .filter(
      ([color, count]) =>
        color !== background && (outgoingColor(color) || count >= 500),
    )
    .map(([color]) => color);
  for (const color of candidates) {
    for (let y = headerBottom; y < bodyBottom; y += 1) {
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
              ny >= bodyBottom
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
        const chatWidth = bounds.right - bounds.left;
        // A banner (e.g. "not in your contact list") spans the whole chat and is not a message.
        if (
          (outgoingColor(color)
            ? write / (boxWidth * boxHeight) < 0.5
            : write < 1500 || boxWidth < 60 || boxHeight < 28) ||
          boxWidth >= chatWidth * 0.9 ||
          // Touching the top edge of the scanned area means a banner under the chat header.
          (minY <= headerBottom + 4 &&
            !(
              outgoingColor(color) &&
              maxX >= bounds.right - chatWidth * 0.12 &&
              boxHeight > 100 &&
              boxWidth < chatWidth * 0.85
            ))
        )
          continue;
        const side = outgoingColor(color)
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
          outgoingColor: outgoingColor(color),
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

export function chatgptPanelHeader(
  words: readonly { text: string; left: number; top: number }[],
  width: number,
  height: number,
  boundaries: readonly number[],
) {
  return words.find(
    (word) =>
      normalizeOcr(word.text).length >= 6 &&
      normalizeOcr(word.text).length <= 8 &&
      textSimilarity('chatgpt', word.text) >=
        1 - 1 / Math.max(7, normalizeOcr(word.text).length) &&
      word.top > 26 &&
      word.top < Math.min(110, height * 0.15) &&
      boundaries.some((x) => x > width * 0.45 && x < word.left - 20),
  );
}

export function chatColumnBounds(
  width: number,
  boundaries: readonly number[],
  profileOpen = false,
  panelHeaderLeft?: number,
) {
  const left = boundaries.find((x) => x > width * 0.08 && x < width * 0.4);
  const panelCandidates = profileOpen
    ? boundaries.filter(
        (x) =>
          x > width * 0.45 &&
          x <
            (panelHeaderLeft === undefined
              ? width * 0.98
              : panelHeaderLeft - 20),
      )
    : [];
  const panelBoundary = profileOpen
    ? [...panelCandidates].sort((a, b) =>
        panelHeaderLeft === undefined
          ? Math.abs(a / width - 0.77) - Math.abs(b / width - 0.77)
          : b - a,
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
  if (
    /noconnectivity|noconnection|немаєз’єднання|dialog|modal|error|warning|помилка|попередження/.test(
      value,
    )
  )
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
