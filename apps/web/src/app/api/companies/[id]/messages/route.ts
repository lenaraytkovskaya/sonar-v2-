import { apiUser, validId } from '@/lib/api-access';
import { emailResponse } from '@/lib/email-api';
import { uk } from '@/i18n/uk';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  if (!(await apiUser(request)))
    return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  if (!validId(id))
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  return emailResponse(async () => {
    const { getCompanyMessaging } = await import('@sonar/db/email');
    return getCompanyMessaging(id);
  });
}
export async function POST(request: Request, context: Context) {
  const user = await apiUser(request, true);
  if (!user) return Response.json({ error: uk.unauthorized }, { status: 401 });
  const { id } = await context.params;
  const data = await request.json().catch(() => null);
  if (!validId(id))
    return Response.json({ error: uk.ai.invalid }, { status: 400 });
  return emailResponse(async () => {
    const email = await import('@sonar/db/email');
    if (data?.action === 'block') {
      await email.blockCompany(id, user.id);
      return { ok: true };
    }
    if (
      ['approve', 'submit'].includes(data?.action) &&
      validId(data.messageId)
    ) {
      const state = await email.getCompanyMessaging(id);
      if (!state.messages.some((message) => message.id === data.messageId))
        return Response.json({ error: uk.ai.invalid }, { status: 400 });
      const accepted =
        data.action === 'approve'
          ? await email.approveMessage(data.messageId, user.id)
          : await email.submitMessage(data.messageId, user.id);
      return accepted
        ? { ok: true }
        : Response.json({ error: uk.ai.invalid }, { status: 400 });
    }
    if (
      data?.action !== 'send' ||
      !validId(data.campaignId) ||
      !validId(data.accountId) ||
      !validId(data.idempotencyKey) ||
      typeof data.toAddress !== 'string' ||
      typeof data.subject !== 'string' ||
      typeof data.body !== 'string' ||
      (data.channel !== undefined &&
        !['email', 'form', 'telegram', 'whatsapp'].includes(data.channel))
    )
      return Response.json({ error: uk.ai.invalid }, { status: 400 });
    return email.createCompanyMessage(
      {
        companyId: id,
        campaignId: data.campaignId,
        accountId: data.accountId,
        toAddress: data.toAddress,
        subject: data.subject,
        body: data.body,
        idempotencyKey: data.idempotencyKey,
        submit: true,
        channel:
          data.channel === 'whatsapp'
            ? 'whatsapp'
            : data.channel === 'telegram'
              ? 'telegram'
              : data.channel === 'form'
                ? 'form'
                : 'email',
      },
      user.id,
    );
  });
}
