import { uk } from '@/i18n/uk';
export async function manualEntryResponse(error: unknown) {
  const { ManualEntryError } = await import('@sonar/db/companies');
  if (!(error instanceof ManualEntryError)) throw error;
  const message = uk.manual.errors[error.code];
  return Response.json(
    { error: message + (error.reasonUk ? ': ' + error.reasonUk : '') },
    { status: error.code.startsWith('duplicate') ? 409 : 400 },
  );
}
