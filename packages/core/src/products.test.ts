import { expect, it } from 'vitest';
import { productOfferText, productSchema } from './products.js';

it('normalizes product input and keeps optional fields empty', () => {
  expect(productSchema.parse({ name: ' Product ' })).toMatchObject({
    name: 'Product',
    status: 'active',
    links: [],
    terms: '',
  });
});
it.each([
  { name: '' },
  { name: 'x'.repeat(121) },
  { description: 'x'.repeat(20001) },
  { tagline: 'One sentence. Another sentence.' },
  { tagline: 'First\nSecond' },
  { links: [{ label: 'Site', url: 'http://example.com' }] },
  { photos: ['javascript:alert(1)'] },
  { videos: ['https://user:password@example.com'] },
  { links: Array(21).fill({ label: 'Site', url: 'https://example.com' }) },
  { photos: Array(31).fill('https://example.com/photo') },
  { videos: Array(11).fill('https://example.com/video') },
  { status: 'deleted' },
  { unknown: true },
])('rejects invalid product data %j', (fields) => {
  expect(productSchema.safeParse({ name: 'Product', ...fields }).success).toBe(
    false,
  );
});
it('includes the offer allowlist and never includes human terms or future fields', () => {
  const product = {
    ...productSchema.parse({
      name: 'Product',
      tagline: 'One sentence.',
      description: 'Description',
      audience: 'Audience',
      benefits: 'First\n\n Second',
      terms: 'SECRET TERMS',
      links: [{ label: 'Site', url: 'https://example.com' }],
      photos: ['https://example.com/secret-photo'],
      videos: ['https://example.com/secret-video'],
    }),
    internal_notes: 'SECRET NOTES',
  };
  expect(productOfferText(product)).toBe(
    'Product\n\nOne sentence.\n\nDescription\n\nAudience\n\n- First\n- Second\n\nSite: https://example.com',
  );
  expect(
    productOfferText(productSchema.parse({ name: 'Product', terms: 'HIDDEN' })),
  ).toBe('Product');
});
it.each(['not-a-url', '', 'https://'])(
  'returns validation errors rather than throwing for malformed URLs (%s)',
  (url) => {
    expect(
      productSchema.safeParse({ name: 'Product', photos: [url] }).success,
    ).toBe(false);
  },
);
