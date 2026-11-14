import {
  extractCompanyTender,
  summarizeCompanyTenders,
  type ProzorroCompanySnapshot,
} from '@sonar/core';
import { sonarPool } from '@sonar/db';
import {
  prozorroCompanyCode,
  saveProzorroCompanySnapshot,
} from '@sonar/db/prozorro';
import {
  boss,
  runTask,
  finishEnrichment,
  enqueueProzorroCompany,
  reconcileProzorroCompanyTasks,
  type TaskOutcome,
} from '@sonar/db/tasks';
import {
  ProzorroHttp,
  ProzorroHttpError,
  sharedProzorroHttp,
} from './prozorro-http.js';
type SearchRow = { tenderID?: unknown; dateCreated?: unknown; date?: unknown };
type SearchPage = {
  data: SearchRow[];
  total: number;
  page: number;
  per_page: number;
};
export function readCompanySearch(raw: unknown): SearchPage {
  const page = raw as SearchPage;
  if (
    !Array.isArray(page?.data) ||
    !Number.isInteger(page.total) ||
    page.total < 0 ||
    !Number.isInteger(page.page) ||
    page.page < 0 ||
    !Number.isInteger(page.per_page) ||
    page.per_page < 1 ||
    page.data.length > page.per_page
  )
    throw Error('Invalid Prozorro search response');
  return page;
}
function publicationDay(value: unknown): string | null {
  if (typeof value !== 'string' || !/^UA-\d{4}-\d{2}-\d{2}-[\w-]+$/.test(value))
    return null;
  const day = value.slice(3, 13),
    parsed = new Date(day);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === day
    ? day
    : null;
}
export async function lookupProzorroCompany(
  code: string,
  months: number,
  max: number,
  http: Pick<ProzorroHttp, 'get' | 'search' | 'summary'>,
  check: () => Promise<void> = async () => {},
  now = new Date(),
  maxPages = 10,
): Promise<ProzorroCompanySnapshot> {
  const fromDate = new Date(now),
    day = fromDate.getUTCDate();
  fromDate.setUTCDate(1);
  fromDate.setUTCMonth(fromDate.getUTCMonth() - months);
  const last = new Date(
    Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth() + 1, 0),
  ).getUTCDate();
  fromDate.setUTCDate(Math.min(day, last));
  const from = fromDate.toISOString().slice(0, 10),
    to = now.toISOString().slice(0, 10);
  const candidates = new Map<string, string>();
  let searchTotal = 0,
    searchPages = 0,
    searchRows = 0,
    invalidRows = 0,
    duplicateRows = 0,
    dateConflicts = 0;
  let totalChanged = false,
    exhausted = false,
    expectedPage = 0,
    previousDay = '9999-99-99',
    orderStable = true;
  const seen = new Set<string>();
  // The portal notice-date filter loses reporting tenders (captured fixture).
  // No early stop on old dates: dateCreated is absent on observed search rows.
  // Scan only this participant, within the configured page budget and portal's 1000 cap.
  while (searchPages < maxPages && searchRows < 1000) {
    await check();
    const query = new URLSearchParams({
      'tenderer[0]': code,
      sort_by: 'dateCreated',
      order: 'desc',
    });
    if (expectedPage) query.set('page', String(expectedPage));
    const page = readCompanySearch(await http.search(query));
    if (
      (expectedPage === 0 && ![0, 1].includes(page.page)) ||
      (expectedPage !== 0 && page.page !== expectedPage)
    )
      throw Error('Invalid Prozorro search page');
    if (!searchPages) searchTotal = page.total;
    else if (searchTotal !== page.total) totalChanged = true;
    searchPages++;
    for (const row of page.data.slice(0, 1000 - searchRows)) {
      searchRows++;
      const published = publicationDay(row?.tenderID);
      if (!published) {
        invalidRows++;
        continue;
      }
      const id = row.tenderID as string;
      if (seen.has(id)) {
        duplicateRows++;
        continue;
      }
      seen.add(id);
      if (published > previousDay) orderStable = false;
      previousDay = published;
      const created =
        typeof row.dateCreated === 'string'
          ? row.dateCreated.slice(0, 10)
          : null;
      if (
        created &&
        (!Number.isFinite(Date.parse(row.dateCreated as string)) ||
          created !== published)
      )
        dateConflicts++;
      if (published >= from && published <= to) candidates.set(id, published);
    }
    if (page.data.length < page.per_page || seen.size >= searchTotal) {
      exhausted = true;
      break;
    }
    // Captured default page=0 and explicit page=1 both return the first 20 rows; next is 2.
    expectedPage = page.page <= 1 ? 2 : page.page + 1;
  }
  const periodCountExact =
    exhausted &&
    seen.size === searchTotal &&
    searchTotal < 1000 &&
    !totalChanged &&
    !invalidRows &&
    !duplicateRows &&
    !dateConflicts &&
    orderStable;
  const tenders = [];
  let inspected = 0,
    invalidDetails = 0,
    unmatchedDetails = 0,
    resolverRejected = 0;
  for (const [tenderId] of [...candidates].sort(
    (a, b) => b[1].localeCompare(a[1]) || b[0].localeCompare(a[0]),
  )) {
    if (inspected >= max) break;
    await check();
    const summary = (await http.summary(tenderId)) as {
      id?: string;
      tenderID?: string;
    };
    if (
      !/^[a-f\d]{32}$/i.test(summary?.id ?? '') ||
      summary.tenderID !== tenderId
    ) {
      resolverRejected++;
      continue;
    }
    await check();
    inspected++;
    const detail = (await http.get(`tenders/${summary.id}`)) as {
      data?: { id?: string; tenderID?: string };
    };
    if (detail?.data?.id !== summary.id || detail.data?.tenderID !== tenderId) {
      invalidDetails++;
      continue;
    }
    try {
      const tender = extractCompanyTender(detail, code);
      if (tender) tenders.push(tender);
      else unmatchedDetails++;
    } catch {
      invalidDetails++;
    }
  }
  return {
    code,
    checkedAt: now.toISOString(),
    from,
    to,
    months,
    searchTotal,
    searchTotalScope: 'all_time',
    searchTotalCapped: searchTotal >= 1000,
    periodFilter: 'tenderID_publication_day',
    periodParticipationCount: candidates.size,
    periodCountExact,
    searchPages,
    searchRows,
    invalidRows,
    duplicateRows,
    dateConflicts,
    totalChanged,
    orderStable,
    searchExhausted: exhausted,
    inspected,
    invalidDetails,
    unmatchedDetails,
    resolverRejected,
    coverage:
      periodCountExact &&
      inspected === candidates.size &&
      !invalidDetails &&
      !unmatchedDetails &&
      !resolverRejected
        ? 'all_period_results'
        : 'sample',
    ...summarizeCompanyTenders(tenders),
  };
}
class CompanyPaused extends Error {}
function identityChanged(): TaskOutcome {
  return {
    status: 'skipped',
    reasonCode: 'prozorro_identity_changed',
    reasonUk:
      'Код ЄДРПОУ змінився під час пошуку. Результат не збережено; пошук буде повторено для поточного коду.',
  };
}
export async function runProzorroCompany({
  companyId,
  code: queuedCode,
}: {
  companyId: string;
  code?: string | null;
  version?: string;
}): Promise<TaskOutcome> {
  const { rows } = await sonarPool.query(
    "select key,value from settings where key like 'prozorro.%' or key='scanner.user_agent'",
  );
  const config = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const check = async () => {
    const { rows } = await sonarPool.query(
      "select value from settings where key='prozorro.enabled'",
    );
    if (rows[0]?.value !== true)
      throw new CompanyPaused('Пошук у Prozorro вимкнено в налаштуваннях.');
  };
  try {
    await check();
    const code = await prozorroCompanyCode(companyId);
    if (!code)
      return {
        status: 'skipped',
        reasonCode: 'prozorro_missing_edrpou',
        reasonUk: 'Немає коду ЄДРПОУ',
      };
    if (queuedCode !== undefined && queuedCode !== code)
      return identityChanged();
    const number = (key: string, min: number, max: number) => {
      const value = Number(config[`prozorro.${key}`]);
      if (!Number.isFinite(value) || value < min || value > max)
        throw Error(`Invalid Prozorro setting: ${key}`);
      return value;
    };
    const months = number('company.months', 1, 120),
      max = number('company.max_tenders', 1, 20),
      maxPages = number('company.max_search_pages', 1, 50);
    if (
      !Number.isInteger(months) ||
      !Number.isInteger(max) ||
      !Number.isInteger(maxPages)
    )
      throw Error('Invalid Prozorro company limits');
    const http = sharedProzorroHttp({
      rate: number('rate_per_second', 0.1, 50),
      timeoutMs: number('timeout_ms', 1, 120000),
      retries: number('max_retries', 0, 10),
      retryDelayMs: number('retry_delay_ms', 1, 60000),
      userAgent: config['scanner.user_agent'],
    });
    const snapshot = await lookupProzorroCompany(
      code,
      months,
      max,
      http,
      check,
      new Date(),
      maxPages,
    );
    await check();
    if ((await saveProzorroCompanySnapshot(companyId, snapshot)) === false)
      return identityChanged();
    return { status: 'done', result: snapshot };
  } catch (error) {
    if (error instanceof CompanyPaused)
      return {
        status: 'paused',
        reasonCode: 'prozorro_disabled',
        reasonUk: error.message,
      };
    if (error instanceof ProzorroHttpError)
      return {
        status:
          error.status === 429 || error.status >= 500 ? 'paused' : 'failed',
        reasonCode: `prozorro_http_${error.status}`,
        reasonUk:
          error.status === 429
            ? 'Prozorro обмежив частоту запитів. Повтори вичерпано; відновіть завдання пізніше.'
            : error.status >= 500
              ? 'Prozorro тимчасово недоступний. Повтори вичерпано; відновіть завдання пізніше.'
              : `Prozorro відхилив запит (HTTP ${error.status}). Перевірте доступність закупівлі та повторіть.`,
      };
    return {
      status: 'failed',
      reasonCode: 'prozorro_company_failed',
      reasonUk:
        'Не вдалося перевірити закупівлі компанії в Prozorro. Перевірте підключення або формат відповіді та повторіть.',
    };
  }
}
export async function registerProzorroCompanyTasks() {
  await boss.createQueue('prozorro.company');
  await runTask(
    'prozorro.company',
    (payload) => runProzorroCompany(payload as { companyId: string }),
    async (payload) => {
      const { companyId, code } = payload as {
        companyId: string;
        code?: string | null;
      };
      if (
        code !== undefined &&
        code !== (await prozorroCompanyCode(companyId))
      ) {
        await enqueueProzorroCompany(companyId);
        return;
      }
      await finishEnrichment(companyId);
    },
  );
  await boss.createQueue('prozorro.company.reconcile');
  await boss.work('prozorro.company.reconcile', async () => {
    await reconcileProzorroCompanyTasks();
  });
  await boss.schedule('prozorro.company.reconcile', '* * * * *');
  await reconcileProzorroCompanyTasks();
}
