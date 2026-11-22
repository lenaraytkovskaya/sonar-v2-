import { z } from 'zod';
export const campaignProgressPollSchema = z.number().int().min(5000).max(10000);

function taskStage(type: string) {
  if (type.startsWith('google.')) return 0;
  if (/^(site\.|registry\.|prozorro\.)/.test(type)) return 1;
  if (type === 'company.score') return 2;
  if (type === 'company.analyze') return 3;
  if (type === 'ai.drafts' || type === 'ai.reply') return 4;
  if (type === 'message.send') return 5;
  return 6;
}

export function orderedTaskTypes(
  counts: readonly { type: string; status: string; count: number }[],
  activeOnly = false,
) {
  return [
    ...new Set(
      counts
        .filter(
          (row) =>
            row.count > 0 &&
            (!activeOnly ||
              row.status === 'queued' ||
              row.status === 'running'),
        )
        .map((row) => row.type),
    ),
  ].sort((a, b) => taskStage(a) - taskStage(b) || a.localeCompare(b));
}
