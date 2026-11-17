import {
  verifyResendWebhook,
  webhookObject,
  webhookString,
} from '@/lib/webhook-auth';

export async function POST(request: Request) {
  if (!process.env.RESEND_WEBHOOK_SECRET)
    return new Response(null, { status: 503 });
  const body = await request.text();
  if (!verifyResendWebhook(body, request.headers))
    return new Response(null, { status: 401 });
  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!webhookObject(event) || !webhookString(event.type))
    return new Response(null, { status: 400 });
  const data = event.data;
  if (
    ['email.delivered', 'email.bounced', 'email.complained'].includes(
      event.type,
    )
  ) {
    if (
      !webhookObject(data) ||
      !webhookString(data.email_id) ||
      !webhookString(event.created_at) ||
      !Number.isFinite(Date.parse(event.created_at))
    )
      return new Response(null, { status: 400 });
    const { recordResendEvent } = await import('@sonar/db/email');
    await recordResendEvent(
      event.type as 'email.delivered' | 'email.bounced' | 'email.complained',
      data.email_id,
      new Date(event.created_at),
    );
    return Response.json({ ok: true });
  }
  if (event.type !== 'email.received') return Response.json({ ok: true });
  if (
    !webhookObject(data) ||
    !webhookString(data.email_id) ||
    !Array.isArray(data.to) ||
    !data.to.length ||
    !data.to.every(webhookString) ||
    !webhookString(event.created_at) ||
    !Number.isFinite(Date.parse(event.created_at))
  )
    return new Response(null, { status: 400 });
  const { enqueueTask } = await import('@sonar/db/tasks');
  await enqueueTask('email.receive', `email.receive:${data.email_id}`, {
    emailId: data.email_id,
    eventId: request.headers.get('svix-id')!,
    receivedAt: event.created_at,
    recipients: data.to,
  });
  return Response.json({ ok: true });
}
