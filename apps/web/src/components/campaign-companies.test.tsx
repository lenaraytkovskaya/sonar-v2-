import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('@/i18n/uk', () => import('../i18n/uk'));
import { CampaignCompaniesLink } from './campaign-companies';

describe('campaign companies', () => {
  it.each([0, 40])(
    'links to the complete list with count %i and no table',
    (total) => {
      const html = renderToStaticMarkup(
        createElement(CampaignCompaniesLink, {
          campaignId: 'campaign-id',
          total,
        }),
      );
      expect(html).toContain('href="/companies?campaign=campaign-id"');
      expect(html).toContain(`Компанії кампанії: ${total} →`);
      expect(html).not.toContain('<table');
    },
  );
});
