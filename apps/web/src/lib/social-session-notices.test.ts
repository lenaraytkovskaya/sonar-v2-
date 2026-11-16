import { expect, it } from 'vitest';
import { claimSocialSessionEvent } from './social-session-notices';

it('shows each loss once across polls and page reloads while allowing a new loss', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const seen = new Set<string>();
  expect(claimSocialSessionEvent('user:account', 'loss-1', seen, storage)).toBe(
    true,
  );
  expect(claimSocialSessionEvent('user:account', 'loss-1', seen, storage)).toBe(
    false,
  );
  expect(
    claimSocialSessionEvent('user:account', 'loss-1', new Set(), storage),
  ).toBe(false);
  expect(claimSocialSessionEvent('user:account', 'loss-2', seen, storage)).toBe(
    true,
  );
  expect(
    claimSocialSessionEvent('other-user:account', 'loss-1', seen, storage),
  ).toBe(true);
  expect([...values.values()]).toEqual(['loss-2', 'loss-1']);
});
it('does not repeat a toast when browser storage is unavailable', () => {
  const storage = {
    getItem: () => {
      throw Error('blocked');
    },
    setItem: () => {},
  };
  const seen = new Set<string>();
  expect(claimSocialSessionEvent('key', 'loss', seen, storage)).toBe(true);
  expect(claimSocialSessionEvent('key', 'loss', seen, storage)).toBe(false);
});
