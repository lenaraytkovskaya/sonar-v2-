import { describe, expect, it } from 'vitest';
import { isAllowedRequestOrigin } from './request-origin';

describe('retry request origin', () => {
  it.each([
    ['https://crm.example', 'crm.example', undefined, undefined],
    ['http://localhost:3000', 'localhost:3000', undefined, undefined],
    ['https://crm.example', 'web:3000', 'crm.example', undefined],
    [
      'https://public.example',
      'web:3000',
      'proxy.example',
      'https://public.example/base',
    ],
    ['https://crm.example', 'crm.example', undefined, 'invalid'],
  ])(
    'accepts %s for host %s, forwarded host %s, app %s',
    (origin, host, forwarded, app) => {
      const headers = new Headers({ origin, host });
      if (forwarded !== undefined) headers.set('x-forwarded-host', forwarded);
      expect(isAllowedRequestOrigin(headers, app)).toBe(true);
    },
  );

  it.each([
    undefined,
    'null',
    'invalid',
    'https://crm.example.attacker.example',
    'https://attacker.example/crm.example',
    'https://crm.example@attacker.example',
    'https://attacker.example@crm.example',
    'https://crm.example/path',
    'https://crm.example?query',
    'https://crm.example#hash',
    'https://crm.example:444',
    'ftp://crm.example',
  ])('rejects missing, malformed or mismatched origin %s', (origin) => {
    const headers = new Headers({ host: 'crm.example' });
    if (origin !== undefined) headers.set('origin', origin);
    expect(isAllowedRequestOrigin(headers, 'https://public.example')).toBe(
      false,
    );
  });

  it('uses forwarded host instead of falling back to internal host', () => {
    const headers = new Headers({
      origin: 'https://internal.example',
      host: 'internal.example',
      'x-forwarded-host': 'crm.example',
    });
    expect(isAllowedRequestOrigin(headers)).toBe(false);
    headers.set('x-forwarded-host', 'crm.example, internal.example');
    expect(isAllowedRequestOrigin(headers)).toBe(false);
  });

  it('requires the complete configured app origin, including scheme and port', () => {
    for (const origin of [
      'http://public.example',
      'https://public.example:444',
      'https://public.example.attacker.example',
    ]) {
      expect(
        isAllowedRequestOrigin(
          new Headers({ origin, host: 'web:3000' }),
          'https://public.example',
        ),
      ).toBe(false);
    }
  });
});
