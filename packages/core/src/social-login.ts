import { createHmac } from 'node:crypto';
import {
  decryptTelegramSession,
  encryptTelegramSession,
} from './telegram-crypto.js';

export type SocialCredentials = {
  login: string;
  password: string;
  totpSecret?: string;
};
export function normalizeTotpSecret(raw: string): string {
  if (typeof raw !== 'string') throw new Error('Некоректний секрет TOTP.');
  const value = raw.replace(/[\s-]/g, '').toUpperCase().replace(/=+$/, '');
  if (
    !/^[A-Z2-7]{16,256}$/.test(value) ||
    ![0, 2, 4, 5, 7].includes(value.length % 8)
  )
    throw new Error('Некоректний секрет TOTP.');
  const leftover = (value.length * 5) % 8;
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(
    value[value.length - 1]!,
  );
  if (leftover && last & ((1 << leftover) - 1))
    throw new Error('Некоректний секрет TOTP.');
  return value;
}
function base32(raw: string): Buffer {
  const secret = normalizeTotpSecret(raw);
  let bits = 0,
    accumulator = 0;
  const bytes: number[] = [];
  for (const char of secret) {
    accumulator =
      (accumulator << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 255);
      accumulator &= (1 << bits) - 1;
    }
  }
  if (accumulator !== 0) throw new Error('Некоректний секрет TOTP.');
  return Buffer.from(bytes);
}
/** RFC 6238; all time values are milliseconds at the public boundary. */
export function generateTotp(
  secret: string,
  options: {
    nowMs?: number;
    digits?: 6 | 8;
    algorithm?: 'sha1' | 'sha256' | 'sha512';
    periodSeconds?: number;
  } = {},
): string {
  const {
    nowMs = Date.now(),
    digits = 6,
    algorithm = 'sha1',
    periodSeconds = 30,
  } = options;
  if (
    !Number.isFinite(nowMs) ||
    nowMs < 0 ||
    !Number.isSafeInteger(periodSeconds) ||
    periodSeconds < 1 ||
    ![6, 8].includes(digits)
  )
    throw new Error('Некоректні параметри TOTP.');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / 1000 / periodSeconds)));
  const digest = createHmac(algorithm, base32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  const value = digest.readUInt32BE(offset) & 0x7fffffff;
  return (value % 10 ** digits).toString().padStart(digits, '0');
}
function credentials(value: SocialCredentials): SocialCredentials {
  if (
    !value ||
    typeof value.login !== 'string' ||
    !value.login.trim() ||
    value.login.length > 320 ||
    typeof value.password !== 'string' ||
    !value.password ||
    value.password.length > 1024
  )
    throw new Error('Вкажіть коректний логін і пароль соцмережі.');
  if (
    value.totpSecret !== undefined &&
    (typeof value.totpSecret !== 'string' || !value.totpSecret)
  )
    throw new Error('Некоректний секрет TOTP.');
  return {
    login: value.login.trim(),
    password: value.password,
    ...(value.totpSecret
      ? { totpSecret: normalizeTotpSecret(value.totpSecret) }
      : {}),
  };
}
export function encryptSocialCredentials(
  value: SocialCredentials,
  secret: string,
): string {
  return encryptTelegramSession(JSON.stringify(credentials(value)), secret);
}
function encryptedValue(value: string): string {
  const parts = value.split('.');
  if (
    parts.length !== 4 ||
    parts[0] !== 'v1' ||
    parts
      .slice(1)
      .some(
        (part) => Buffer.from(part, 'base64url').toString('base64url') !== part,
      )
  )
    throw new Error();
  return value;
}
export function decryptSocialCredentials(
  value: string,
  secret: string,
): SocialCredentials {
  try {
    return credentials(
      JSON.parse(
        decryptTelegramSession(encryptedValue(value), secret),
      ) as SocialCredentials,
    );
  } catch {
    throw new Error(
      'Не вдалося розшифрувати дані входу. Збережіть їх повторно.',
    );
  }
}
function loginCode(value: string): string {
  const code = value.replace(/[\s-]/g, '');
  if (!/^\d{4,10}$/.test(code))
    throw new Error('Вкажіть коректний код підтвердження.');
  return code;
}
export function encryptSocialLoginCode(code: string, secret: string): string {
  return encryptTelegramSession(loginCode(code), secret);
}
export function decryptSocialLoginCode(value: string, secret: string): string {
  try {
    return loginCode(decryptTelegramSession(encryptedValue(value), secret));
  } catch {
    throw new Error('Не вдалося розшифрувати код підтвердження.');
  }
}
