import { expect, it } from 'vitest';
import { parseOutreachDraft } from './outreach.js';

it('requires an email subject and preserves the company language', () => {
  expect(
    parseOutreachDraft(
      '```json\n{"subject":"Oferta","body":"Dzień dobry!"}\n```',
      'email',
      500,
    ),
  ).toEqual({ subject: 'Oferta', body: 'Dzień dobry!' });
  for (const subject of ['', 'Injected\r\nBcc:other@example.org'])
    expect(() =>
      parseOutreachDraft(
        JSON.stringify({ subject, body: 'Hello' }),
        'email',
        500,
      ),
    ).toThrow();
});
it('uses body-only drafts outside email and enforces messenger and social length', () => {
  for (const channel of ['form', 'social', 'telegram', 'whatsapp'] as const)
    expect(parseOutreachDraft('{"body":"Hello"}', channel, 5)).toEqual({
      subject: '',
      body: 'Hello',
    });
  for (const channel of ['telegram', 'whatsapp', 'social'] as const)
    expect(() => parseOutreachDraft('{"body":"Hello!"}', channel, 5)).toThrow();
});
it('rejects empty bodies, malformed JSON and unexpected instructions', () => {
  for (const text of ['{"body":" "}', '{"body":"Hello","send":true}', 'Hello'])
    expect(() => parseOutreachDraft(text, 'social', 500)).toThrow();
});
it('selects top three distinct enabled contacts by rank, with social drafts available manually', async () => {
  const { selectOutreachContacts } = await import('./outreach.js');
  const contacts = [
    { id: 'a', kind: 'email', normalized: 'A@example.org', rank: 8 },
    { id: 'b', kind: 'email', normalized: 'a@example.org', rank: 7 },
    { id: 'c', kind: 'telegram', normalized: '@one', rank: 9 },
    { id: 'd', kind: 'form', normalized: 'https://one.org', rank: 6 },
    {
      id: 'e',
      kind: 'social',
      normalized: 'https://facebook.com/one',
      rank: 5,
    },
    { id: 'f', kind: 'phone', normalized: '+380501234567', rank: 10 },
    { id: 'g', kind: 'whatsapp', normalized: '+380501234567', rank: 4 },
  ];
  expect(
    selectOutreachContacts(contacts, {
      email: true,
      forms: true,
      whatsapp: true,
    }).map((c) => c.id),
  ).toEqual(['a', 'd', 'e']);
  expect(contacts.map((c) => c.id)).toEqual([
    'a',
    'b',
    'c',
    'd',
    'e',
    'f',
    'g',
  ]);
});
