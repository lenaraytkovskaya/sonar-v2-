import { expect, it, vi } from 'vitest';
import { socialTarget } from '@sonar/core';
import { SocialSessionCheckError } from '@sonar/core/social-session';
import { sendFacebook } from './facebook-send-browser.js';

const target = socialTarget(
  'https://www.facebook.com/profile.php?id=100000000000001',
)!;

function fakePage(scenario: string) {
  const timeout = () =>
    Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  const header = {
    filter: () => header,
    first: () => header,
    waitFor: async () => {
      if (scenario === 'header_timeout') throw timeout();
    },
    count: async () => (scenario === 'header_timeout' ? 0 : 1),
  };
  const actions = {
    filter: () => actions,
    or: () => actions,
    first: () => actions,
    waitFor: async () => {
      if (scenario === 'button_timeout') throw timeout();
    },
    count: async () => (scenario === 'action_count' ? 2 : 1),
  };
  const main = {
    getByRole: () => actions,
  };
  return {
    on: () => {},
    goto: async () => {
      if (scenario === 'navigation_timeout')
        throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      return { status: () => 200 };
    },
    url: () =>
      scenario === 'profile_mismatch'
        ? 'https://www.facebook.com/other-profile/'
        : target.canonicalUrl,
    context: () => ({ cookies: async () => [] }),
    locator: (selector: string) =>
      selector.startsWith('main h1') ? header : main,
  };
}

it.each([
  ['navigation timeout', 'navigation_timeout', 'navigation'],
  ['profile URL mismatch', 'profile_mismatch', 'profile'],
  ['heading timeout', 'header_timeout', 'profile'],
  ['button timeout', 'button_timeout', 'profile'],
  ['action_count', 'action_count', 'profile'],
])(
  '%s captures the failure before exiting sendFacebook',
  async (_, scenario, phase) => {
    const capture = vi.fn(async (phase: string) => {
      expect(phase).toBeTruthy();
    });
    await expect(
      sendFacebook(
        fakePage(scenario) as never,
        target,
        5,
        'synthetic body',
        async () => {},
        async () => {},
        undefined,
        capture,
      ),
    ).rejects.toThrow();
    expect(capture).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0]?.[0]).toBe(phase);
  },
);

it('captures check() exceptions before its second session check', async () => {
  const capture = vi.fn(async (phase: string) => {
    expect(phase).toBeTruthy();
  });
  let checks = 0;
  await expect(
    sendFacebook(
      fakePage('check_error') as never,
      target,
      5,
      'synthetic body',
      async () => {},
      async () => {
        checks += 1;
        throw new SocialSessionCheckError('checkpoint');
      },
      undefined,
      capture,
    ),
  ).rejects.toThrow();
  expect(checks).toBeGreaterThan(0);
  expect(capture).toHaveBeenCalledOnce();
  expect(capture.mock.calls[0]?.[0]).toBe('navigation');
});
