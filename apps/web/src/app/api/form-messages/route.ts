import { apiUser } from '@/lib/api-access';
import { emailResponse } from '@/lib/email-api';
import { uk } from '@/i18n/uk';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  if (!(await apiUser(request)))
    return Response.json({ error: uk.unauthorized }, { status: 401 });
  const response = await emailResponse(async () => {
    const { listFormMessages } = await import('@sonar/db/forms');
    return listFormMessages();
  });
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
