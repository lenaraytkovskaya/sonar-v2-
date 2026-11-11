import { z } from 'zod';

export const analysisChannels = [
  'email',
  'telegram',
  'whatsapp',
  'viber',
  'form',
  'phone',
] as const;
export const analysisResultSchema = z
  .object({
    summary: z.string().trim().min(1).max(4000),
    language: z.string().regex(/^[a-z]{2,3}(?:-[a-zA-Z]{2,4})?$/),
    best_channel: z.enum(analysisChannels).nullable(),
    first_message: z.string().max(4000),
    fit: z.number().min(0).max(100),
    fit_reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export type AnalysisResult = z.infer<typeof analysisResultSchema>;
export function parseAnalysis(
  text: string,
  contacts: { kind: string }[],
  about: string,
): AnalysisResult {
  const result = analysisResultSchema.parse(JSON.parse(text));
  if (
    result.best_channel &&
    !contacts.some((c) => c.kind === result.best_channel)
  )
    throw new Error('Analysis selected an unavailable channel');
  return { ...result, ...(!about.trim() ? { first_message: '' } : {}) };
}
