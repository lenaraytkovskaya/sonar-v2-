import { apiUser, validId } from '@/lib/api-access';
import { uk } from '@/i18n/uk';
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  const data = await request.json().catch(() => null);
  if (!validId(id) || !validId(data?.factId))
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  const { adoptWebsiteCandidate, WebsiteCandidateError } =
    await import('@sonar/db/companies');
  try {
    return Response.json(await adoptWebsiteCandidate(id, data.factId, user.id));
  } catch (error) {
    if (!(error instanceof WebsiteCandidateError)) throw error;
    return Response.json(
      {
        error:
          error.message === 'scanRunning'
            ? uk.company.scanRunning
            : uk.company.staleCandidate,
      },
      { status: 409 },
    );
  }
}
