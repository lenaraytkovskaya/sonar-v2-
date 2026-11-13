import { expect, it } from 'vitest';
import {
  parseInboundCategory,
  parseReplyDraft,
  receivedEmailContent,
} from './inbound.js';
it.each([
  'interest',
  'question',
  'price',
  'contract',
  'complaint',
  'refusal',
  'autoreply',
])('accepts only known inbound category %s', (category) => {
  expect(parseInboundCategory(JSON.stringify({ category }))).toBe(category);
});
it('rejects unstructured or injected classifier output', () => {
  for (const text of [
    'refusal',
    '{"category":"send_message"}',
    '{"category":null}',
  ])
    expect(() => parseInboundCategory(text)).toThrow();
});
it('extracts case-insensitive threading headers and inert HTML text', () => {
  expect(
    receivedEmailContent({
      from: 'Sender <sender@example.com>',
      to: ['Team <team@example.com>'],
      html: '<style>hidden</style><p>Hello<br>Team</p><script>evil()</script>',
      headers: {
        'In-Reply-To': '<prior@example.com>',
        References: '<first@example.com> <prior@example.com>',
      },
    }),
  ).toEqual({
    sender: 'sender@example.com',
    recipients: ['team@example.com'],
    body: 'Hello\nTeam',
    subject: '',
    inReplyTo: '<prior@example.com>',
    references: ['<first@example.com>', '<prior@example.com>'],
    externalMessageId: undefined,
  });
});

it('validates reply draft JSON without saving model prose or injected mail headers', () => {
  expect(parseReplyDraft('{"subject":"Re: Hello","body":" Draft "}')).toEqual({
    subject: 'Re: Hello',
    body: 'Draft',
  });
  for (const text of [
    'prose',
    '{"body":""}',
    JSON.stringify({ body: 'OK', subject: 'Hello\nBcc: other@example.com' }),
  ])
    expect(() => parseReplyDraft(text)).toThrow();
});
