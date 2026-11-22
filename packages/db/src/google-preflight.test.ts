import { expect, it, vi } from 'vitest';
vi.mock('./index.js', () => ({ sonarPool: {} }));
vi.mock('./tasks.js', () => ({ logActivity: vi.fn() }));
import { checkGooglePlanBudget } from './budget.js';
it.each(['monthly', 'service', 'campaign'] as const)(
  'checks the complete planned total against %s budget',
  async (scope) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('select monthly_limit'))
        return {
          rows: [{ monthly_limit_usd: scope === 'service' ? '0.1' : null }],
        };
      if (sql.startsWith('select value'))
        return { rows: [{ value: scope === 'monthly' ? 0.1 : 1 }] };
      if (sql.startsWith('with costs'))
        return { rows: [{ monthly: 0, service: 0 }] };
      if (sql.startsWith('select id,budget_usd'))
        return {
          rows: [
            { id: 'campaign', budget_usd: scope === 'campaign' ? '0.1' : '1' },
          ],
        };
      return { rows: [{ cost: 0 }] };
    });
    await expect(
      checkGooglePlanBudget({ query } as never, 'campaign', 3 * 0.035),
    ).rejects.toMatchObject({ scope });
  },
);
