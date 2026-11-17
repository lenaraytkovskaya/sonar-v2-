import { z } from 'zod';

export const outreachChannels = [
  'email',
  'telegram',
  'whatsapp',
  'viber',
  'form',
  'social',
] as const;
export type OutreachChannel = (typeof outreachChannels)[number];

export function selectOutreachContacts<
  T extends { id: string; kind: string; normalized: string; rank: number },
>(contacts: T[], channels: Record<string, boolean>) {
  if (!Object.values(channels).some((enabled) => enabled === true)) return [];
  const seen = new Set<string>();
  return contacts
    .filter(
      (contact) =>
        (outreachChannels.includes(contact.kind as OutreachChannel) ||
          contact.kind === 'phone') &&
        (contact.kind === 'social' ||
          (contact.kind === 'phone'
            ? channels.viber === true
            : channels[contact.kind === 'form' ? 'forms' : contact.kind] ===
              true)),
    )
    .sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id))
    .flatMap((contact) => {
      const key = `${contact.kind}:${contact.normalized.trim().toLowerCase()}`;
      if (!contact.normalized.trim() || seen.has(key)) return [];
      seen.add(key);
      return [
        {
          ...contact,
          channel: (contact.kind === 'phone'
            ? 'viber'
            : contact.kind) as OutreachChannel,
        },
      ];
    })
    .slice(0, 3);
}

export class OutreachDraftError extends Error {
  constructor(
    readonly code:
      'invalid_json' | 'invalid_shape' | 'email_subject' | 'short_length',
  ) {
    super(code);
  }
}

export function parseOutreachDraft(
  text: string,
  channel: OutreachChannel,
  shortMaxLength: number,
) {
  const json = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new OutreachDraftError('invalid_json');
  }
  const parsed = z
    .object({
      subject: z.string().trim().max(998).optional(),
      body: z.string().trim().min(1).max(10000),
    })
    .strict()
    .safeParse(value);
  if (!parsed.success) throw new OutreachDraftError('invalid_shape');
  const draft = parsed.data;
  if (channel === 'email' && (!draft.subject || /[\r\n]/.test(draft.subject)))
    throw new OutreachDraftError('email_subject');
  if (
    (channel === 'telegram' ||
      channel === 'whatsapp' ||
      channel === 'viber' ||
      channel === 'social') &&
    draft.body.length > shortMaxLength
  )
    throw new OutreachDraftError('short_length');
  return {
    subject: channel === 'email' ? draft.subject! : '',
    body: draft.body,
  };
}

/** Return the first unresolved square/curly placeholder, ignoring numeric references. */
export function findMessagePlaceholder(text: string): string | null {
  return (
    text.match(
      /\[[^[\]\r\n]*[\p{L}_][^[\]\r\n]*\]|\{[^{}\r\n]*[\p{L}_][^{}\r\n]*\}/u,
    )?.[0] ?? null
  );
}
