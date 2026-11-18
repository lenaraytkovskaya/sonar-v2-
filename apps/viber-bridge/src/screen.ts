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
) {
  const prefix = Array.from(expected.trim()).slice(0, 60).join('');
  return (
    !normalizeOcr(composer) && textSimilarity(prefix, outgoingBubble) >= 0.8
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
