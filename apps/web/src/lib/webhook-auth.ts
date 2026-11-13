import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhookKey(actual: string | null, secret?: string) {
  if (!actual || !secret) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(actual), digest(secret));
}

export function verifyResendWebhook(
  body: string,
  headers: Headers,
  secret = process.env.RESEND_WEBHOOK_SECRET,
  now = Date.now(),
) {
  const id = headers.get('svix-id');
  const timestamp = headers.get('svix-timestamp');
  const signatures = headers.get('svix-signature');
  if (!secret || !id || !timestamp || !signatures) return false;
  // Svix's protocol replay window is five minutes in either direction.
  if (
    !/^\d+$/.test(timestamp) ||
    !Number.isSafeInteger(Number(timestamp)) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300
  )
    return false;
  const encoded = secret.replace(/^whsec_/, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  const key = Buffer.from(encoded, 'base64');
  if (!key.length) return false;
  // https://docs.svix.com/receiving/verifying-payloads/how-manual
  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
  return signatures.split(/\s+/).some((signature) => {
    const [version, value] = signature.split(',');
    return version === 'v1' && verifyWebhookKey(value ?? null, expected);
  });
}

export function webhookObject(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function webhookString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
