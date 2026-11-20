import { scannerKeys, validScannerSettings } from '@/lib/scanner-settings';
import { socialKeys, validSocialSettings } from '@/lib/social-settings';
import {
  profilesSchema,
  validFinanceRates,
  validSendHoursExemptCompanyIds,
} from '@sonar/core';
import { apiUser } from '@/lib/api-access';
import { uk } from '@/i18n/uk';
export async function GET(request: Request) {
  if (!(await apiUser(request)))
    return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { sonarPool } = await import('@sonar/db');
  const { rows } = await sonarPool.query(
    'select key,value from settings where key=any($1)',
    [
      [
        'ai.models',
        'ai.model.cheap',
        'ai.model.strong',
        'budget.monthly_usd',
        'send.hours_exempt_company_ids',
        'finance.rates',
        'finance.renewal_reminder_days',
        'company.about',
        'analysis.prompt',
        'email.resend.last_event',
        'google.field_profiles',
        'retention.google_days',
        'registry.phones.progress',
        'prozorro.enabled',
        'prozorro.full_sync.enabled',
        'prozorro.tender.progress',
        'prozorro.contract.progress',
        ...scannerKeys,
        ...socialKeys,
      ],
    ],
  );
  const exemptIds =
    rows.find((row) => row.key === 'send.hours_exempt_company_ids')?.value ??
    [];
  const { rows: hoursExemptCompanies } = await sonarPool.query(
    'select id,name from companies where id=any($1::uuid[]) order by name,id',
    [validSendHoursExemptCompanyIds(exemptIds) ? exemptIds : []],
  );
  return Response.json({
    'send.hours_exempt_company_ids': [],
    hoursExemptCompanies,
    'budget.monthly_usd': Number(process.env.MONTHLY_BUDGET_USD ?? 50),
    'finance.rates': { USD: 1, UAH: 0.024, EUR: 1.08 },
    'finance.renewal_reminder_days': 3,
    ...Object.fromEntries(rows.map((row) => [row.key, row.value])),
  });
}
export async function POST(request: Request) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const data = await request.json().catch(() => null);
  if (
    !data ||
    (data.analysisPrompt !== undefined &&
      (typeof data.analysisPrompt !== 'string' ||
        !data.analysisPrompt.trim() ||
        data.analysisPrompt.length > 20000)) ||
    (data.hoursExemptCompanyIds !== undefined &&
      !validSendHoursExemptCompanyIds(data.hoursExemptCompanyIds)) ||
    (data.scanner !== undefined && !validScannerSettings(data.scanner)) ||
    (data.social !== undefined && !validSocialSettings(data.social)) ||
    typeof data.about !== 'string' ||
    data.about.length > 20000 ||
    !Number.isFinite(data.budget) ||
    data.budget < 0 ||
    data.budget > 1e9 ||
    typeof data.cheap !== 'string' ||
    typeof data.strong !== 'string' ||
    (data.googleProfiles !== undefined &&
      !profilesSchema.safeParse(data.googleProfiles).success) ||
    (data.googleDays !== undefined &&
      (!Number.isInteger(data.googleDays) ||
        data.googleDays < 1 ||
        data.googleDays > 3650)) ||
    (data.financeRates !== undefined &&
      !validFinanceRates(data.financeRates)) ||
    (data.renewalReminderDays !== undefined &&
      (!Number.isInteger(data.renewalReminderDays) ||
        data.renewalReminderDays < 0 ||
        data.renewalReminderDays > 90))
  )
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { sonarPool } = await import('@sonar/db');
  const { rows } = await sonarPool.query(
    "select value from settings where key='ai.models'",
  );
  const models = (rows[0]?.value ?? []) as { id: string }[];
  if (
    [data.cheap, data.strong].some(
      (id) => id && !models.some((model) => model.id === id),
    )
  )
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const client = await sonarPool.connect();
  try {
    await client.query('begin');
    if (data.analysisPrompt !== undefined) {
      await client.query(
        "select value from settings where key='analysis.prompt' for update",
      );
      await client.query(
        `update settings set value=to_jsonb(gen_random_uuid()::text),updated_at=now()
         where key='analysis.version' and exists(select 1 from settings where key='analysis.prompt' and value is distinct from $1::jsonb)`,
        [JSON.stringify(data.analysisPrompt)],
      );
    }
    for (const [key, value] of Object.entries({
      ...(data.scanner ?? {}),
      ...(data.social ?? {}),
      ...(data.analysisPrompt !== undefined
        ? { 'analysis.prompt': data.analysisPrompt }
        : {}),
      ...(data.hoursExemptCompanyIds !== undefined
        ? {
            'send.hours_exempt_company_ids': [
              ...new Set(
                (data.hoursExemptCompanyIds as string[]).map((id) =>
                  id.toLowerCase(),
                ),
              ),
            ],
          }
        : {}),
      'company.about': data.about,
      'budget.monthly_usd': data.budget,
      'ai.model.cheap': data.cheap,
      'ai.model.strong': data.strong,
      ...(data.googleProfiles !== undefined
        ? { 'google.field_profiles': data.googleProfiles }
        : {}),
      ...(data.googleDays !== undefined
        ? { 'retention.google_days': data.googleDays }
        : {}),
      ...(data.financeRates !== undefined
        ? { 'finance.rates': data.financeRates }
        : {}),
      ...(data.renewalReminderDays !== undefined
        ? { 'finance.renewal_reminder_days': data.renewalReminderDays }
        : {}),
    }))
      await client.query(
        'insert into settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value,updated_at=now()',
        [key, JSON.stringify(value)],
      );
    const { logActivity } = await import('@sonar/db/tasks');
    await logActivity('settings.update', 'settings', null, user.id, {}, client);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
  return Response.json({ ok: true });
}
