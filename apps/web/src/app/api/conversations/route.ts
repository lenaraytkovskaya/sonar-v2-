import { apiUser } from '@/lib/api-access';
import { emailResponse } from '@/lib/email-api';
import { inboxFilters } from '@/lib/inbox-filters';
import { uk } from '@/i18n/uk';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  if (!(await apiUser(request)))
    return Response.json({ error: uk.unauthorized }, { status: 401 });
  const response = await emailResponse(async () => {
    const { getInbox } = await import('@sonar/db/outreach');
    return getInbox(
      inboxFilters(Object.fromEntries(new URL(request.url).searchParams)),
    );
  });
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
