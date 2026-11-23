import { expect, it } from 'vitest';
import { filterUrl } from './filter-url';

it('replaces filters immediately while preserving unrelated URL state', () => {
  expect(
    filterUrl(
      'https://sonar.test/inbox?campaignId=old&unread=1&conversation=old&page=4&tab=messages#list',
      [
        ['campaignId', 'new'],
        ['channel', 'email'],
      ],
      ['campaignId', 'channel', 'unread'],
    ),
  ).toBe('/inbox?tab=messages&campaignId=new&channel=email#list');
});

it('clears empty text and unchecked fields without persisting empty parameters', () => {
  expect(
    filterUrl(
      'https://sonar.test/companies?q=old&hasPhone=true',
      [
        ['q', '  '],
        ['city', ' Kyiv '],
      ],
      ['q', 'city', 'hasPhone'],
    ),
  ).toBe('/companies?city=Kyiv');
});
