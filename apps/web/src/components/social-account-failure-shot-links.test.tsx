import { expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SocialAccountFailureShotLinks } from './social-account-failure-shot-links';

it('shows send and check links when an account has no reasonUk', () => {
  const html = renderToStaticMarkup(
    <SocialAccountFailureShotLinks
      accountId="123e4567-e89b-12d3-a456-426614174000"
      network="facebook"
      kinds={['send', 'check']}
    />,
  );
  expect(html).toContain('kind=send');
  expect(html).toContain('kind=check');
  expect(html).toContain('failure-dom');
});
