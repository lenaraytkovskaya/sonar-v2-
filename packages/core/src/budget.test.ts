import { describe, expect, it } from 'vitest';
import { BudgetExceeded, checkBudget, moneyUnits } from './budget.js';
const base = {
  monthlyLimitUsd: 50,
  monthlySpentUsd: 10,
  serviceLimitUsd: 20,
  serviceSpentUsd: 2,
};
describe('budget', () => {
  it('allows within both limits and at the exact boundary', () => {
    expect(() => checkBudget(base, 18)).not.toThrow();
    expect(() =>
      checkBudget({ ...base, monthlyLimitUsd: 28 }, 18),
    ).not.toThrow();
  });
  it('rejects monthly excess', () =>
    expect(() => checkBudget({ ...base, monthlyLimitUsd: 11 }, 2)).toThrow(
      BudgetExceeded,
    ));
  it('rejects service excess', () => {
    try {
      checkBudget(base, 19);
      throw Error('should reject');
    } catch (error) {
      expect(error).toMatchObject({ scope: 'service' });
    }
  });
  it('zero budget blocks even zero estimated cost', () => {
    expect(() => checkBudget({ ...base, monthlyLimitUsd: 0 }, 0)).toThrow(
      BudgetExceeded,
    );
    expect(() => checkBudget({ ...base, serviceLimitUsd: 0 }, 0)).toThrow(
      BudgetExceeded,
    );
  });
  it('allows no service cap while enforcing the global cap', () => {
    expect(() =>
      checkBudget({ ...base, serviceLimitUsd: null }, 40),
    ).not.toThrow();
    expect(() => checkBudget({ ...base, serviceLimitUsd: null }, 41)).toThrow(
      BudgetExceeded,
    );
  });
  it('handles decimal arithmetic at a boundary', () =>
    expect(() =>
      checkBudget(
        {
          monthlyLimitUsd: 0.3,
          monthlySpentUsd: 0.1 + 0.2,
          serviceLimitUsd: null,
          serviceSpentUsd: 0,
        },
        0,
      ),
    ).not.toThrow());
  it.each([-1, NaN, Infinity])('rejects invalid amounts %s', (value) =>
    expect(() => moneyUnits(value)).toThrow(),
  );
});
