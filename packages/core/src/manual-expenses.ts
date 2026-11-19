export const manualExpenseCurrencies = ['USD', 'UAH', 'EUR'] as const;
export const manualExpenseCategories = [
  'proxy',
  'phone',
  'subscription',
  'other',
] as const;

export type ManualExpenseCurrency = (typeof manualExpenseCurrencies)[number];
export type ManualExpenseCategory = (typeof manualExpenseCategories)[number];

export type FinanceRates = Record<ManualExpenseCurrency, number>;

export function validFinanceRates(value: unknown): value is FinanceRates {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rates = value as Record<string, unknown>;
  return (
    Object.keys(rates).every((key) =>
      manualExpenseCurrencies.includes(key as ManualExpenseCurrency),
    ) &&
    rates.USD === 1 &&
    ['UAH', 'EUR'].every(
      (currency) =>
        typeof rates[currency] === 'number' &&
        Number.isFinite(rates[currency]) &&
        rates[currency]! > 0 &&
        rates[currency]! <= 1e6 &&
        Number(rates[currency]!.toFixed(10)) === rates[currency],
    )
  );
}

export function validManualExpenseInput(value: unknown): value is {
  title: string;
  category: ManualExpenseCategory;
  amount: number;
  currency: ManualExpenseCurrency;
  paidOn: string;
  paidUntil: string | null;
  accountId: string | null;
  note: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const validDate = (date: unknown) =>
    typeof date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) &&
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
  return (
    typeof input.title === 'string' &&
    !!input.title.trim() &&
    input.title.trim().length <= 200 &&
    manualExpenseCategories.includes(input.category as ManualExpenseCategory) &&
    typeof input.amount === 'number' &&
    Number.isFinite(input.amount) &&
    input.amount > 0 &&
    input.amount <= 1e9 &&
    Number(input.amount.toFixed(10)) === input.amount &&
    manualExpenseCurrencies.includes(input.currency as ManualExpenseCurrency) &&
    validDate(input.paidOn) &&
    (input.paidUntil === null || validDate(input.paidUntil)) &&
    (input.accountId === null ||
      (typeof input.accountId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          input.accountId,
        ))) &&
    typeof input.note === 'string' &&
    input.note.length <= 4000
  );
}

export function convertToUsd(amount: number, rate: number): number {
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !Number.isFinite(rate) ||
    rate <= 0
  )
    throw new Error('Invalid manual expense conversion');
  return Number((amount * rate).toFixed(10));
}

export function manualExpenseTotals(automaticUsd: number, manualUsd: number) {
  return {
    automaticUsd,
    manualUsd,
    combinedUsd: automaticUsd + manualUsd,
  };
}

export function renewalState(
  paidUntil: string,
  today: string,
  reminderDays: number,
): 'overdue' | 'upcoming' | null {
  if (paidUntil < today) return 'overdue';
  const end = new Date(`${today}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + reminderDays);
  return paidUntil <= end.toISOString().slice(0, 10) ? 'upcoming' : null;
}

export function continuedExpenseDates(
  previousPaidUntil: string | null,
  paidUntil: string,
): boolean {
  return !!previousPaidUntil && paidUntil > previousPaidUntil;
}
