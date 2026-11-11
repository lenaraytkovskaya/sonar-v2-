import { apiUser, validId } from '@/lib/api-access';
import { emailResponse } from '@/lib/email-api';
import { uk } from '@/i18n/uk';
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; phase: string }> },
) {
  if (!(await apiUser(request)))
    return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id, phase } = await context.params;
  if (!validId(id) || (phase !== 'before' && phase !== 'after'))
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  return emailResponse(async () => {
    const { getFormScreenshot } = await import('@sonar/db/forms');
    const bytes = await getFormScreenshot(id, phase);
    return bytes
      ? new Response(new Uint8Array(bytes), {
          headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox",
          },
        })
      : Response.json({ error: uk.forms.screenshotMissing }, { status: 404 });
  });
}
