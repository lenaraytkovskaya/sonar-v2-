import { describe, expect, it } from 'vitest';
import {
  continuedExpenseDates,
  convertToUsd,
  manualExpenseTotals,
  renewalState,
  validFinanceRates,
  validManualExpenseInput,
} from './manual-expenses.js';

describe('manual expenses', () => {
  it('converts amounts using the saved exchange rate', () => {
    expect(convertToUsd(1000, 0.024)).toBe(24);
    expect(convertToUsd(10, 1.08)).toBe(10.8);
    expect(convertToUsd(10, 1)).toBe(10);
    expect(validFinanceRates({ USD: 1, UAH: 0.024, EUR: 1.08 })).toBe(true);
    expect(validFinanceRates({ USD: 2, UAH: 0.024, EUR: 1.08 })).toBe(false);
    expect(() => convertToUsd(1, 0)).toThrow();
  });

  it('keeps manual expenses outside the automatic paid request budget', () => {
    expect(manualExpenseTotals(16, 9.5)).toEqual({
      automaticUsd: 16,
      manualUsd: 9.5,
      combinedUsd: 25.5,
    });
  });

  it('classifies upcoming and overdue renewal dates by calendar day', () => {
    expect(renewalState('2026-11-19', '2026-11-19', 3)).toBe('upcoming');
    expect(renewalState('2026-11-22', '2026-11-19', 3)).toBe('upcoming');
    expect(renewalState('2026-11-23', '2026-11-19', 3)).toBeNull();
    expect(renewalState('2026-11-18', '2026-11-19', 3)).toBe('overdue');
  });

  it('requires a later coverage date for a continued payment', () => {
    expect(continuedExpenseDates('2026-11-18', '2026-12-18')).toBe(true);
    expect(continuedExpenseDates('2026-11-18', '2026-11-18')).toBe(false);
    expect(continuedExpenseDates(null, '2026-12-18')).toBe(false);
  });

  it('validates positive amounts, supported currencies, and dates', () => {
    const input = {
      title: 'Proxy',
      category: 'proxy',
      amount: 10,
      currency: 'UAH',
      paidOn: '2026-11-19',
      paidUntil: null,
      accountId: null,
      note: '',
    };
    expect(validManualExpenseInput(input)).toBe(true);
    expect(validManualExpenseInput({ ...input, amount: 0 })).toBe(false);
    expect(validManualExpenseInput({ ...input, currency: 'PLN' })).toBe(false);
    expect(validManualExpenseInput({ ...input, paidOn: '2026-02-30' })).toBe(
      false,
    );
  });
});
