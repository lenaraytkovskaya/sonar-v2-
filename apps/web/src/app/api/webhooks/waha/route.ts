import {
  verifyWebhookKey,
  webhookObject,
  webhookString,
} from '@/lib/webhook-auth';

export async function POST(request: Request) {
  if (!process.env.WAHA_API_KEY) return new Response(null, { status: 503 });
  if (
    !verifyWebhookKey(
      request.headers.get('x-api-key'),
      process.env.WAHA_API_KEY,
    )
  )
    return new Response(null, { status: 401 });
  let event: unknown;
  try {
    event = await request.json();
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!webhookObject(event) || !webhookString(event.event))
    return new Response(null, { status: 400 });
  if (event.event !== 'message') return Response.json({ ok: true });
  const data = event.payload;
  if (!webhookObject(data)) return new Response(null, { status: 400 });
  if (data.fromMe === true) return Response.json({ ok: true });
  if (
    !webhookString(event.session) ||
    !webhookString(data.id) ||
    !webhookString(data.from) ||
    data.fromMe !== false ||
    (data.body !== undefined && typeof data.body !== 'string') ||
    typeof data.timestamp !== 'number' ||
    !Number.isSafeInteger(data.timestamp) ||
    data.timestamp < 0 ||
    !Number.isFinite(new Date(data.timestamp * 1000).getTime())
  )
    return new Response(null, { status: 400 });
  const { enqueueTask } = await import('@sonar/db/tasks');
  await enqueueTask(
    'whatsapp.receive',
    `whatsapp.receive:${JSON.stringify([event.session, data.id])}`,
    {
      session: event.session,
      id: data.id,
      from: data.from,
      body: data.body ?? '',
      timestamp: data.timestamp,
    },
  );
  return Response.json({ ok: true });
}
