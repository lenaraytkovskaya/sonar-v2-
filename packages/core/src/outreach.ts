import { z } from 'zod';

export const outreachChannels = [
  'email',
  'telegram',
  'whatsapp',
  'form',
  'social',
] as const;
export type OutreachChannel = (typeof outreachChannels)[number];

export function selectOutreachContacts<
  T extends { id: string; kind: string; normalized: string; rank: number },
>(contacts: T[], channels: Record<string, boolean>) {
  const seen = new Set<string>();
  return contacts
    .filter(
      (contact) =>
        outreachChannels.includes(contact.kind as OutreachChannel) &&
        (contact.kind === 'social' ||
          channels[contact.kind === 'form' ? 'forms' : contact.kind] === true),
    )
    .sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id))
    .flatMap((contact) => {
      const key = `${contact.kind}:${contact.normalized.trim().toLowerCase()}`;
      if (!contact.normalized.trim() || seen.has(key)) return [];
      seen.add(key);
      return [{ ...contact, channel: contact.kind as OutreachChannel }];
    })
    .slice(0, 3);
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
  const draft = z
    .object({
      subject: z.string().trim().max(998).optional(),
      body: z.string().trim().min(1).max(10000),
    })
    .strict()
    .parse(JSON.parse(json));
  if (channel === 'email' && (!draft.subject || /[\r\n]/.test(draft.subject)))
    throw new Error('Email requires a single-line subject');
  if (
    (channel === 'telegram' ||
      channel === 'whatsapp' ||
      channel === 'social') &&
    draft.body.length > shortMaxLength
  )
    throw new Error('Short draft exceeds configured length');
  return {
    subject: channel === 'email' ? draft.subject! : '',
    body: draft.body,
  };
}
