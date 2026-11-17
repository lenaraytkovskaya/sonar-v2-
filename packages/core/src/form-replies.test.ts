import { expect, it } from 'vitest';
import {
  deterministicFormReplyMatch,
  deterministicFormReplyMatchEvidence,
  parseFormReplyMatch,
  type ReplyMatchCompany,
} from './form-replies.js';
const company: ReplyMatchCompany = {
  id: 'a',
  website: 'https://www.example.com/contact',
  countryCode: 'PL',
  contacts: [
    { kind: 'email', value: 'info@other.com' },
    { kind: 'phone', value: '512 345 678' },
    { kind: 'telegram', value: 'https://t.me/Test_company' },
  ],
};
it('matches exact normalized email domains, including company email contacts', () => {
  expect(
    deterministicFormReplyMatch(
      'email',
      ['Person <person@example.com>'],
      [company],
    ),
  ).toBe('a');
  expect(
    deterministicFormReplyMatch('email', ['person@other.com'], [company]),
  ).toBe('a');
  expect(
    deterministicFormReplyMatch('email', ['person@notexample.com'], [company]),
  ).toBeNull();
});
it('requires a unique company rather than picking the first shared domain', () => {
  expect(
    deterministicFormReplyMatch(
      'email',
      ['person@example.com'],
      [company, { ...company, id: 'b' }],
    ),
  ).toBeNull();
});
it('uses campaign country to normalize phones and ignores opaque WhatsApp LIDs', () => {
  expect(
    deterministicFormReplyMatch('whatsapp', ['+48512345678'], [company]),
  ).toBe('a');
  expect(
    deterministicFormReplyMatch('telegram', ['512345678'], [company]),
  ).toBe('a');
  expect(
    deterministicFormReplyMatch(
      'whatsapp',
      ['whatsapp:lid:48512345678'],
      [company],
    ),
  ).toBeNull();
});
it('matches Telegram usernames without case or link decoration', () => {
  expect(
    deterministicFormReplyMatch('telegram', ['@TEST_company'], [company]),
  ).toBe('a');
});
it('validates strict JSON, confidence and candidate membership', () => {
  expect(
    parseFormReplyMatch(
      '{"companyId":"a","confidence":0.8,"reasonUk":"Збіг назви."}',
      ['a'],
    ).companyId,
  ).toBe('a');
  expect(
    parseFormReplyMatch(
      '{"companyId":null,"confidence":0,"reasonUk":"Немає збігу."}',
      [],
    ).companyId,
  ).toBeNull();
  for (const value of [
    { companyId: 'b', confidence: 1, reasonUk: 'Збіг' },
    { companyId: 'a', confidence: 1.1, reasonUk: 'Збіг' },
    { companyId: 'a', confidence: '1', reasonUk: 'Збіг' },
    { companyId: 'a', confidence: 1, reasonUk: 'Збіг', extra: true },
  ])
    expect(() => parseFormReplyMatch(JSON.stringify(value), ['a'])).toThrow();
});

it('records the actual phone evidence when a Telegram username does not match', () => {
  expect(
    deterministicFormReplyMatchEvidence(
      'telegram',
      ['@unknown_user', '+48512345678'],
      [company],
    ),
  ).toEqual({ companyId: 'a', kind: 'phone', value: '+48512345678' });
});
