import { isIP } from 'node:net';
type Attempt = { token: symbol; until: number };
export class LoginLimiter {
  private attempts = new Map<string, Attempt[]>();
  private nextSweep = 0;
  constructor(
    private now = Date.now,
    private limit = 5,
    private windowMs = 15 * 60 * 1000,
  ) {}
  begin(email: string, ip: string): ((success: boolean) => void) | null {
    const now = this.now();
    if (now >= this.nextSweep) {
      for (const [key, values] of this.attempts) {
        const live = values.filter((value) => value.until > now);
        if (live.length) this.attempts.set(key, live);
        else this.attempts.delete(key);
      }
      this.nextSweep = now + 60000;
    }
    const keys = [`email:${email.trim().toLowerCase()}`, `ip:${ip}`];
    const lists = keys.map((key) =>
      (this.attempts.get(key) ?? []).filter((value) => value.until > now),
    );
    if (lists.some((values) => values.length >= this.limit)) return null;
    const attempt = { token: Symbol(), until: now + this.windowMs };
    keys.forEach((key, index) =>
      this.attempts.set(key, [...lists[index]!, attempt]),
    );
    let finished = false;
    return (success) => {
      if (finished) return;
      finished = true;
      if (!success) {
        attempt.until = this.now() + this.windowMs;
        return;
      }
      for (const key of keys) {
        const rest = (this.attempts.get(key) ?? []).filter(
          (value) => value.token !== attempt.token,
        );
        if (rest.length) this.attempts.set(key, rest);
        else this.attempts.delete(key);
      }
    };
  }
}
// The reverse proxy must append/overwrite the real peer address. Ignore spoofable leftmost hops.
export function loginClientIp(headers: Pick<Headers, 'get'>) {
  const forwarded = headers.get('x-forwarded-for')?.split(',').at(-1)?.trim();
  const address = forwarded || headers.get('x-real-ip')?.trim() || '';
  return isIP(address) ? address : 'unknown';
}
export const loginLimiter = new LoginLimiter();
