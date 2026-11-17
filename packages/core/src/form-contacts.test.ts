import { expect, it } from 'vitest';
import {
  prepareFormContacts,
  sharedFormContactsFromValues,
} from './form-contacts.js';

const contacts = {
  email: 'hello@example.com',
  phone: '+380501234567',
  telegram: '@sonar_team',
  whatsapp: '+380671234567',
};
it('appends missing phone and Telegram once and reports only shared contacts', () => {
  const prepared = prepareFormContacts(contacts, 'Hello', ['email', 'name']);
  expect(prepared).toEqual({
    body: 'Hello\n\nЗв’язатися: телефон +380501234567, Telegram @sonar_team',
    sharedContacts: ['email', 'phone', 'telegram'],
  });
  expect(prepareFormContacts(contacts, prepared.body, ['email'])).toEqual(
    prepared,
  );
});
it('uses existing formatted phone and Telegram links without duplication', () => {
  const body = 'Call +38 (050) 123-45-67 or https://t.me/sonar_team';
  expect(prepareFormContacts(contacts, body, [])).toEqual({
    body,
    sharedContacts: ['phone', 'telegram'],
  });
});
it('keeps contact fields out of the message body and includes WhatsApp only when supplied', () => {
  expect(
    prepareFormContacts(contacts, 'Hello', ['phone', 'telegram', 'whatsapp']),
  ).toEqual({
    body: 'Hello',
    sharedContacts: ['phone', 'telegram', 'whatsapp'],
  });
  expect(
    prepareFormContacts({ email: '', phone: '' }, 'Hello', ['email', 'phone']),
  ).toEqual({ body: 'Hello', sharedContacts: [] });
});

it('infers legacy shared contacts from the values saved in the request snapshot', () => {
  expect(
    sharedFormContactsFromValues({
      email: ' hello@example.com ',
      phone: '',
      telegram: '@sonar',
      whatsapp: '  ',
    }),
  ).toEqual(['email', 'telegram']);
});

it('prefers saved shared-contact fields when they are present', () => {
  expect(
    sharedFormContactsFromValues(contacts, ['email', 'phone', 'telegram']),
  ).toEqual(['email', 'phone', 'telegram']);
});
