import type { SessionOptions } from 'iron-session';
export type SessionData = { user?: { id: string; name: string } };
export function sessionOptions(): SessionOptions {
  const password = process.env.AUTH_SECRET;
  if (!password || password.length < 32)
    throw new Error('AUTH_SECRET must contain at least 32 characters');
  return {
    password,
    cookieName: 'sonar-session',
    ttl: 60 * 60 * 24 * 7,
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    },
  };
}
export function safeReturnTo(value: unknown): string {
  return typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    !/[\r\n]/.test(value) &&
    value.split('?')[0] !== '/login'
    ? value
    : '/';
}
