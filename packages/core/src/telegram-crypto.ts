import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

function sessionKey(secret: string) {
  if (secret.length < 32)
    throw new Error('AUTH_SECRET має містити щонайменше 32 символи.');
  return Buffer.from(
    hkdfSync('sha256', secret, 'sonar', 'telegram-session-v1', 32),
  );
}
export function encryptTelegramSession(
  session: string,
  secret: string,
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sessionKey(secret), nonce);
  const encrypted = Buffer.concat([
    cipher.update(session, 'utf8'),
    cipher.final(),
  ]);
  return [
    'v1',
    nonce.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}
export function decryptTelegramSession(value: string, secret: string): string {
  const key = sessionKey(secret);
  try {
    const [version, nonce, tag, payload, extra] = value.split('.');
    if (
      version !== 'v1' ||
      !nonce ||
      !tag ||
      payload === undefined ||
      extra !== undefined
    )
      throw new Error();
    const iv = Buffer.from(nonce, 'base64url');
    const authTag = Buffer.from(tag, 'base64url');
    if (iv.length !== 12 || authTag.length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(Buffer.from(payload, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error(
      'Не вдалося розшифрувати сесію Telegram. Підключіть акаунт повторно.',
    );
  }
}
