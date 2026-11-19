import { apiUser, validId } from '@/lib/api-access';
import { uk } from '@/i18n/uk';
import { manualExpenseCurrencies, validManualExpenseInput } from '@sonar/core';

const respond = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });

export async function GET(request: Request) {
  if (!(await apiUser(request)))
    return respond({ error: uk.unauthorized }, 401);
  const month = new URL(request.url).searchParams.get('month');
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    return respond({ error: uk.ai.invalid }, 400);
  const db = await import('@sonar/db/manual-expenses');
  const [expenses, accounts] = await Promise.all([
    db.listManualExpenses(month),
    db.listManualExpenseAccounts(),
  ]);
  return respond({ expenses, accounts });
}

export async function POST(request: Request) {
  const user = await apiUser(request, true);
  if (!user) return respond({ error: uk.unauthorized }, 401);
  const data = await request.json().catch(() => null);
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return respond({ error: uk.ai.invalid }, 400);
  const db = await import('@sonar/db/manual-expenses');
  const keys = Object.keys(data);
  const invalid = () => respond({ error: uk.ai.invalid }, 400);
  try {
    if (data.action === 'create' || data.action === 'update') {
      const allowed = [
        'action',
        'id',
        'title',
        'category',
        'amount',
        'currency',
        'paidOn',
        'paidUntil',
        'accountId',
        'note',
      ];
      if (
        keys.some((key) => !allowed.includes(key)) ||
        (data.action === 'update' && !validId(data.id)) ||
        (data.action === 'create' && data.id !== undefined) ||
        !validManualExpenseInput({
          title: data.title,
          category: data.category,
          amount: data.amount,
          currency: data.currency,
          paidOn: data.paidOn,
          paidUntil: data.paidUntil,
          accountId: data.accountId,
          note: data.note,
        })
      )
        return invalid();
      const input = {
        title: data.title,
        category: data.category,
        amount: data.amount,
        currency: data.currency,
        paidOn: data.paidOn,
        paidUntil: data.paidUntil,
        accountId: data.accountId,
        note: data.note,
      };
      const expense =
        data.action === 'create'
          ? await db.createManualExpense(input, user.id)
          : await db.updateManualExpense(data.id, input);
      return respond({ expense });
    }
    if (data.action === 'archive') {
      if (
        keys.some((key) => !['action', 'id'].includes(key)) ||
        !validId(data.id)
      )
        return invalid();
      await db.archiveManualExpense(data.id);
      return respond({ ok: true });
    }
    if (data.action === 'continue') {
      if (
        keys.some(
          (key) =>
            ![
              'action',
              'id',
              'amount',
              'currency',
              'paidOn',
              'paidUntil',
            ].includes(key),
        ) ||
        !validId(data.id) ||
        typeof data.currency !== 'string' ||
        !manualExpenseCurrencies.includes(
          data.currency as (typeof manualExpenseCurrencies)[number],
        )
      )
        return invalid();
      const expense = await db.continueManualExpense(
        data.id,
        data.amount,
        data.currency,
        data.paidOn,
        data.paidUntil,
        user.id,
      );
      return respond({ expense });
    }
    return invalid();
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === '23505'
    )
      return respond({ error: uk.finance.manualError }, 409);
    const message = error instanceof Error ? error.message : '';
    if (message.startsWith('Invalid manual expense')) return invalid();
    if (message === 'Manual expense unavailable')
      return respond({ error: uk.finance.manualError }, 404);
    return respond({ error: uk.finance.manualError }, 400);
  }
}
