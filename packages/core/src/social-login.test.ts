import { expect, it } from 'vitest';
import {
  decryptSocialCredentials,
  encryptSocialCredentials,
  generateTotp,
  normalizeTotpSecret,
} from './social-login.js';

it.each([
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
])('matches RFC 6238 SHA1 vector at %i seconds', (seconds, expected) => {
  expect(
    generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', {
      nowMs: seconds * 1000,
      digits: 8,
    }),
  ).toBe(expected);
});
it('supports padded grouped Base32 secrets and six digit leading zeroes', () => {
  expect(normalizeTotpSecret('jbsw-y3dp ehpk3pxp====')).toBe(
    'JBSWY3DPEHPK3PXP',
  );
  expect(
    generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', { nowMs: 1111111109000 }),
  ).toBe('081804');
  expect(() => generateTotp('invalid!')).toThrow();
});
it('encrypts credential sets with randomized authenticated encryption and safe errors', () => {
  const key = 'a'.repeat(32),
    value = {
      login: 'private-login',
      password: 'private-password',
      totpSecret: 'JBSWY3DPEHPK3PXP',
    };
  const encrypted = encryptSocialCredentials(value, key);
  expect(encrypted).not.toContain(value.password);
  expect(encryptSocialCredentials(value, key)).not.toBe(encrypted);
  expect(decryptSocialCredentials(encrypted, key)).toEqual(value);
  expect(() => decryptSocialCredentials(encrypted, 'b'.repeat(32))).toThrow(
    'Не вдалося розшифрувати дані входу',
  );
  expect(() => decryptSocialCredentials(encrypted + 'x', key)).toThrow();
});
function encodeBase32(text: string): string {
  let acc = 0,
    bits = 0,
    result = '';
  for (const byte of Buffer.from(text)) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(acc >>> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits)
    result += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(acc << (5 - bits)) & 31];
  return result;
}
it.each([
  [59, '46119246', '90693936'],
  [1111111109, '68084774', '25091201'],
  [1111111111, '67062674', '99943326'],
  [1234567890, '91819424', '93441116'],
  [2000000000, '90698825', '38618901'],
  [20000000000, '77737706', '47863826'],
])(
  'matches RFC 6238 SHA256/SHA512 vectors at %i seconds',
  (seconds, sha256, sha512) => {
    const secret =
      '1234567890123456789012345678901234567890123456789012345678901234';
    expect(
      generateTotp(encodeBase32(secret.slice(0, 32)), {
        nowMs: seconds * 1000,
        digits: 8,
        algorithm: 'sha256',
      }),
    ).toBe(sha256);
    expect(
      generateTotp(encodeBase32(secret), {
        nowMs: seconds * 1000,
        digits: 8,
        algorithm: 'sha512',
      }),
    ).toBe(sha512);
  },
);
it('rejects malformed base32 lengths, trailing bits and nonstring secrets before saving', () => {
  for (const value of [
    'A'.repeat(17),
    'A'.repeat(19),
    'A'.repeat(16) + 'AB',
    123,
    null,
  ]) {
    expect(() =>
      encryptSocialCredentials(
        { login: 'a', password: 'b', totpSecret: value as string },
        'a'.repeat(32),
      ),
    ).toThrow();
  }
});
it('encrypts manual codes without storing formatting or accepting nonnumeric payloads', async () => {
  const { encryptSocialLoginCode, decryptSocialLoginCode } =
    await import('./social-login.js');
  const key = 'a'.repeat(32),
    encrypted = encryptSocialLoginCode('123 456', key);
  expect(encrypted).not.toContain('123456');
  expect(decryptSocialLoginCode(encrypted, key)).toBe('123456');
  expect(() => encryptSocialLoginCode('secret-code', key)).toThrow();
});
it('resolves only the pinned proxy for logged-out credential login and keeps session checks strict', async () => {
  const { encryptSocialProxy, resolveSocialSession } =
    await import('./social-session.js');
  const key = 'a'.repeat(32);
  const account = {
    channel: 'instagram' as const,
    settings: {
      ownProxyEncrypted: encryptSocialProxy('http://proxy.example:1234', key),
    },
  };
  expect(resolveSocialSession(account, key, '', true)).toMatchObject({
    cookies: [],
    storageState: { cookies: [], origins: [] },
    proxy: { server: 'http://proxy.example:1234' },
  });
  expect(() => resolveSocialSession(account, key, '')).toThrow();
  expect(() =>
    resolveSocialSession({ ...account, settings: {} }, key, '', true),
  ).toThrow();
});
