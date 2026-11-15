import { describe, expect, it } from 'vitest';
import { selectedTab, tabUrl } from './url-tab';

describe('URL tab state', () => {
  const keys = ['googleMaps', 'website', 'contacts'];
  it.each([
    ['', 'googleMaps'],
    ['tab=contacts', 'contacts'],
    ['tab=1', 'googleMaps'],
    ['tab=unknown', 'googleMaps'],
    ['tab=', 'googleMaps'],
    ['tab=CONTACTS', 'googleMaps'],
  ])('validates semantic keys on initial render: %s', (query, expected) => {
    expect(selectedTab(new URLSearchParams(query), 'tab', keys, keys[0]!)).toBe(
      expected,
    );
  });
  it('changes only its own parameter, retaining duplicate filters and the hash', () => {
    const href =
      'http://localhost/companies/id?campaignId=campaign&filter=a&filter=b&tab=website#details';
    const next = new URL(tabUrl(href, 'tab', 'contacts'), href);
    expect(next.pathname).toBe('/companies/id');
    expect(next.searchParams.get('tab')).toBe('contacts');
    expect(next.searchParams.get('campaignId')).toBe('campaign');
    expect(next.searchParams.getAll('filter')).toEqual(['a', 'b']);
    expect(next.hash).toBe('#details');
  });
  it('clears the all-status filter without deleting other UI state', () => {
    expect(
      tabUrl(
        'http://localhost/companies?status=ready&campaignId=c#list',
        'status',
        '',
      ),
    ).toBe('/companies?campaignId=c#list');
  });
});
