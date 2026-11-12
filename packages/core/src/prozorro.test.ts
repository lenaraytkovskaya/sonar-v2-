import { expect, it } from 'vitest';
import { extractProzorroDocument, prozorroCode } from './prozorro.js';
const participant = {
  identifier: { id: '00123456', scheme: 'UA-EDR' },
  name: 'ТОВ Тест',
  contactPoint: {
    name: 'Олена',
    email: ' OFFICE@Example.UA ',
    telephone: '0671234567',
  },
};
const tender = {
  id: 'abc',
  tenderID: 'UA-2026-11-12-000001-a',
  dateModified: '2026-11-12T10:00:00Z',
  title: 'Ремонт',
  value: { amount: 12000, currency: 'UAH' },
  awards: [{ suppliers: [participant, participant] }],
  bids: [{ tenderers: [participant] }],
  procuringEntity: {
    ...participant,
    identifier: { id: '87654321', scheme: 'UA-EDR' },
  },
};
it('extracts all tender participant roles, normalizes contacts and deduplicates awards', () => {
  const doc = extractProzorroDocument('tender', { data: tender });
  expect(doc.parties).toHaveLength(3);
  expect(doc.parties[0]).toMatchObject({
    code: '00123456',
    email: 'office@example.ua',
    telephone: '+380671234567',
    role: 'supplier',
    contactName: 'Олена',
  });
  expect(doc.sourceUrl).toBe(
    'https://prozorro.gov.ua/uk/tender/UA-2026-11-12-000001-a',
  );
  expect(doc.amount).toBe('12000');
});
it('extracts contracts, preserves code-only parties and combines repeated code evidence', () => {
  const doc = extractProzorroDocument('contract', {
    ...tender,
    contractID: 'UA-2026-11-12-000001-a-c1',
    suppliers: [{ identifier: participant.identifier }, participant],
    buyer: participant,
  });
  expect(doc.parties).toHaveLength(2);
  expect(doc.parties[0]?.email).toBe('office@example.ua');
  expect(doc.sourceUrl).toContain('/contract/UA-2026-11-12-000001-a-c1');
});
it('keeps masked participants distinct and never converts redacted codes to matchable codes', () => {
  const masked = {
    ...participant,
    identifier: { id: '12*****678', scheme: 'UA-IPN' },
  };
  const other = { ...masked, contactPoint: { email: 'other@example.ua' } };
  const doc = extractProzorroDocument('contract', {
    ...tender,
    suppliers: [masked, other, masked],
  });
  expect(doc.parties).toHaveLength(2);
  expect(doc.parties.every((p) => prozorroCode(p.code) === null)).toBe(true);
  expect(prozorroCode('12-345678')).toBeNull();
  expect(prozorroCode('0012345678')).toBe('0012345678');
});
it('supports international phones and rejects malformed documents and contacts', () => {
  const doc = extractProzorroDocument('contract', {
    ...tender,
    suppliers: [
      {
        ...participant,
        contactPoint: { telephone: '+4930123456', email: 'wrong' },
      },
    ],
  });
  expect(doc.parties[0]).toMatchObject({
    telephone: '+4930123456',
    email: null,
  });
  expect(() => extractProzorroDocument('contract', { id: 'x' })).toThrow(
    'Invalid',
  );
});

it('does not combine foreign and Ukrainian organizations with the same numeric identifier', () => {
  const foreign = {
    ...participant,
    identifier: { id: '00123456', scheme: 'PL-REGON' },
    contactPoint: { email: 'foreign@example.pl' },
  };
  const doc = extractProzorroDocument('contract', {
    ...tender,
    suppliers: [foreign, participant],
  });
  expect(doc.parties).toHaveLength(2);
  expect(doc.parties.find((p) => p.scheme === 'PL-REGON')?.code).toMatch(
    /^masked:/,
  );
});
