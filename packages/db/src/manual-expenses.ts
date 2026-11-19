import {
  convertToUsd,
  continuedExpenseDates,
  manualExpenseCurrencies,
  validFinanceRates,
  validManualExpenseInput,
  type ManualExpenseCategory,
  type ManualExpenseCurrency,
  type FinanceRates,
} from '@sonar/core';
import { sonarPool } from './index.js';

export type ManualExpenseInput = {
  title: string;
  category: ManualExpenseCategory;
  amount: number;
  currency: ManualExpenseCurrency;
  paidOn: string;
  paidUntil: string | null;
  accountId: string | null;
  note: string;
};

const calendarDate = (value: string | Date) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);

function ratesFrom(value: unknown): FinanceRates {
  if (validFinanceRates(value)) return value;
  if (value === undefined || value === null)
    return { USD: 1, UAH: 0.024, EUR: 1.08 };
  throw new Error('Invalid finance rates');
}

async function currentRates(client: {
  query: (
    sql: string,
    values?: unknown[],
  ) => Promise<{ rows: { value: unknown }[] }>;
}) {
  const { rows } = await client.query(
    "select value from settings where key='finance.rates'",
  );
  return ratesFrom(rows[0]?.value);
}

export async function listManualExpenses(month: string) {
  if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(month) || month.startsWith('0000'))
    throw new Error('Invalid month');
  const { rows } = await sonarPool.query(
    `select e.id,e.title,e.category,e.amount,e.currency,e.amount_usd,e.rate_used,
      to_char(e.paid_on,'YYYY-MM-DD') as paid_on,
      to_char(e.paid_until,'YYYY-MM-DD') as paid_until,
      e.account_id,a.name as account_name,e.note,e.created_by,e.created_at
     from manual_expenses e left join channel_accounts a on a.id=e.account_id
     where e.archived_at is null and e.paid_on >= $1::date
       and e.paid_on < ($1::date + interval '1 month')
     order by e.paid_on desc,e.created_at desc,e.id`,
    [`${month}-01`],
  );
  return rows;
}

export async function listManualExpenseAccounts() {
  const { rows } = await sonarPool.query(
    'select id,name from channel_accounts order by name,id',
  );
  return rows as { id: string; name: string }[];
}

export async function manualExpenseReminders(
  today = new Date().toISOString().slice(0, 10),
) {
  const { rows: settingRows } = await sonarPool.query(
    "select value from settings where key='finance.renewal_reminder_days'",
  );
  const configured = Number(settingRows[0]?.value ?? 3);
  const reminderDays =
    Number.isInteger(configured) && configured >= 0 && configured <= 90
      ? configured
      : 3;
  const { rows } = await sonarPool.query(
    `select e.id,e.title,to_char(e.paid_until,'YYYY-MM-DD') as paid_until,
        case when e.paid_until < $1::date then 'overdue' else 'upcoming' end as status
     from manual_expenses e
     where e.archived_at is null and e.paid_until is not null
       and (e.paid_until < $1::date or e.paid_until <= $1::date + $2::int)
       and not exists (
         select 1 from manual_expenses renewal
         where renewal.renewed_from_id=e.id and renewal.archived_at is null
       )
     order by (e.paid_until >= $1::date),e.paid_until,e.title,e.id`,
    [today, reminderDays],
  );
  return { reminderDays, reminders: rows };
}

export async function createManualExpense(
  input: ManualExpenseInput,
  userId: string,
) {
  if (!validManualExpenseInput(input))
    throw new Error('Invalid manual expense');
  const client = await sonarPool.connect();
  try {
    await client.query('begin');
    const rates = await currentRates(client);
    const rate = rates[input.currency];
    const { rows } = await client.query(
      `insert into manual_expenses
       (title,category,amount,currency,amount_usd,rate_used,paid_on,paid_until,account_id,note,created_by)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       returning id,title,category,amount,currency,amount_usd,rate_used,paid_on,paid_until,account_id,note,created_by,created_at`,
      [
        input.title.trim(),
        input.category,
        input.amount,
        input.currency,
        convertToUsd(input.amount, rate),
        rate,
        input.paidOn,
        input.paidUntil,
        input.accountId,
        input.note,
        userId,
      ],
    );
    await client.query('commit');
    return rows[0];
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function updateManualExpense(
  id: string,
  input: ManualExpenseInput,
) {
  if (!validManualExpenseInput(input))
    throw new Error('Invalid manual expense');
  const client = await sonarPool.connect();
  try {
    await client.query('begin');
    const { rows: current } = await client.query(
      `select amount,currency,archived_at from manual_expenses where id=$1 for update`,
      [id],
    );
    if (!current[0] || current[0].archived_at)
      throw new Error('Manual expense unavailable');
    const changed =
      Number(current[0].amount) !== input.amount ||
      current[0].currency !== input.currency;
    let amountUsd: number | string | undefined;
    let rateUsed: number | string | undefined;
    if (changed) {
      const rates = await currentRates(client);
      rateUsed = rates[input.currency];
      amountUsd = convertToUsd(input.amount, Number(rateUsed));
    }
    const { rows } = await client.query(
      `update manual_expenses set title=$2,category=$3,amount=$4,currency=$5,
         amount_usd=coalesce($6,amount_usd),rate_used=coalesce($7,rate_used),
         paid_on=$8,paid_until=$9,account_id=$10,note=$11
       where id=$1 and archived_at is null
       returning id,title,category,amount,currency,amount_usd,rate_used,paid_on,paid_until,account_id,note,created_by,created_at`,
      [
        id,
        input.title.trim(),
        input.category,
        input.amount,
        input.currency,
        amountUsd ?? null,
        rateUsed ?? null,
        input.paidOn,
        input.paidUntil,
        input.accountId,
        input.note,
      ],
    );
    await client.query('commit');
    return rows[0];
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function archiveManualExpense(id: string) {
  const { rowCount } = await sonarPool.query(
    'update manual_expenses set archived_at=now() where id=$1 and archived_at is null',
    [id],
  );
  if (!rowCount) throw new Error('Manual expense unavailable');
}

export async function continueManualExpense(
  id: string,
  amount: number,
  currency: string,
  paidOn: string,
  paidUntil: string,
  userId: string,
) {
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > 1e9 ||
    !manualExpenseCurrencies.includes(
      currency as (typeof manualExpenseCurrencies)[number],
    ) ||
    !validManualExpenseInput({
      title: 'x',
      category: 'other',
      amount,
      currency,
      paidOn,
      paidUntil,
      accountId: null,
      note: '',
    })
  )
    throw new Error('Invalid manual expense continuation');
  const client = await sonarPool.connect();
  try {
    await client.query('begin');
    const { rows: previous } = await client.query(
      `select id,title,category,paid_until,account_id,note,archived_at
       from manual_expenses where id=$1 for update`,
      [id],
    );
    const expense = previous[0];
    if (!expense || expense.archived_at)
      throw new Error('Manual expense unavailable');
    if (
      !expense.paid_until ||
      !continuedExpenseDates(calendarDate(expense.paid_until), paidUntil)
    )
      throw new Error('Invalid manual expense continuation');
    const rates = await currentRates(client);
    const rate = rates[currency as keyof FinanceRates];
    const { rows } = await client.query(
      `insert into manual_expenses
       (title,category,amount,currency,amount_usd,rate_used,paid_on,paid_until,account_id,note,created_by,renewed_from_id)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       returning id,title,category,amount,currency,amount_usd,rate_used,paid_on,paid_until,account_id,note,created_by,created_at`,
      [
        expense.title,
        expense.category,
        amount,
        currency,
        convertToUsd(amount, rate),
        rate,
        paidOn,
        paidUntil,
        expense.account_id,
        expense.note,
        userId,
        id,
      ],
    );
    await client.query('commit');
    return rows[0];
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
