import { scannerKeys, validScannerSettings } from '@/lib/scanner-settings';
import { profilesSchema } from '@sonar/core';
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
        'company.about',
        'google.field_profiles',
        'retention.google_days',
        ...scannerKeys,
      ],
    ],
  );
  return Response.json({
    'budget.monthly_usd': Number(process.env.MONTHLY_BUDGET_USD ?? 50),
    ...Object.fromEntries(rows.map((row) => [row.key, row.value])),
  });
}
export async function POST(request: Request) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const data = await request.json().catch(() => null);
  if (
    !data ||
    (data.scanner !== undefined && !validScannerSettings(data.scanner)) ||
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
        data.googleDays > 3650))
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
    for (const [key, value] of Object.entries({
      ...(data.scanner ?? {}),
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
