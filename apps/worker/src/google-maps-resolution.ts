import { googleMapsResolutionSchema } from '@sonar/core';
import { transaction } from '@sonar/db/email';
import { TaskFailure } from '@sonar/db/tasks';

type Input = {
  companyId: string;
  campaignId: string;
  sourceUrl: string;
  resolveVersion?: number;
};
type Limits = { timeoutMs: number; maxBytes: number; priceUsd: number };

export async function readGoogleBody(response: Response, maxBytes: number) {
  const invalid = () =>
    new TaskFailure(
      'google_response_size',
      'Відповідь Google перевищує дозволений розмір.',
    );
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw invalid();
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new TaskFailure(
      'google_response_invalid',
      'Google повернув порожню відповідь.',
    );
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw invalid();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}

// Contract: https://developers.google.com/maps/ai/maps-experience-agent-tools/resolution-api
// The endpoint resolves the URL; Sonar never requests the supplied URL or follows redirects.
export async function resolveGoogleMaps(
  input: Input,
  parentId: string,
  limits: Limits,
  fetcher: typeof fetch,
) {
  const key = `google.resolve:${parentId}:${input.resolveVersion ?? 0}`;
  const receipt = await transaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      key,
    ]);
    const {
      rows: [prior],
    } = await client.query(
      'select id,status,result,reason_code,reason_uk from tasks where idempotency_key=$1',
      [key],
    );
    if (prior) return { ...prior, created: false };
    const {
      rows: [row],
    } = await client.query(
      `insert into tasks(type,idempotency_key,payload,subject_type,subject_id,status,started_at) values('google.resolve',$1,$2,'company',$3,'running',now()) returning id`,
      [key, { ...input, parentId }, input.companyId],
    );
    return { ...row, created: true };
  });
  if (!receipt.created) {
    if (
      receipt.status === 'done' &&
      receipt.result?.sourceUrl === input.sourceUrl &&
      typeof receipt.result?.placeId === 'string'
    )
      return {
        placeId: receipt.result.placeId as string,
        receiptId: receipt.id as string,
      };
    throw new TaskFailure(
      receipt.reason_code ?? 'google_resolve_interrupted',
      receipt.reason_uk ??
        'Попереднє визначення місця Google перервано. Повторіть аналіз.',
    );
  }
  try {
    const response = await fetcher(
      'https://mapstools.googleapis.com/v1:resolveMapsUrls',
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(limits.timeoutMs),
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY ?? '',
        },
        body: JSON.stringify({ urls: [input.sourceUrl] }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403, 404].includes(response.status))
        throw new TaskFailure(
          'google_resolve_activation',
          'У Google Cloud увімкніть Maps Experience agent tools API (mapstools.googleapis.com) для проєкту та дозвольте його для ключа Google. Перевірте білінг, ключ і права доступу, потім повторіть аналіз.',
        );
      throw new TaskFailure(
        'google_resolve_http',
        `Не вдалося визначити місце Google (${response.status}). ${response.status === 429 ? 'Квоту вичерпано. Повторіть пізніше.' : 'Повторіть аналіз пізніше.'}`,
      );
    }
    let parsed: ReturnType<typeof googleMapsResolutionSchema.safeParse>;
    try {
      parsed = googleMapsResolutionSchema.safeParse(
        JSON.parse(await readGoogleBody(response, limits.maxBytes)),
      );
    } catch (error) {
      if (error instanceof TaskFailure) throw error;
      throw new TaskFailure(
        'google_resolve_invalid',
        'Google повернув некоректну відповідь визначення місця. Дані компанії не змінено.',
      );
    }
    if (!parsed.success)
      throw new TaskFailure(
        'google_resolve_invalid',
        'Google не повернув одне однозначне місце. Списки та кілька місць не підтримуються.',
      );
    const failures = Object.values(parsed.data.failedRequests ?? {});
    if (failures.length || !parsed.data.entities[0]?.place)
      throw new TaskFailure(
        failures.some((f) => f.code === 13)
          ? 'google_resolve_internal'
          : 'google_resolve_no_place',
        failures.some((f) => f.code === 13)
          ? 'Тимчасова помилка визначення місця Google. Повторіть аналіз пізніше.'
          : 'Google не зміг визначити одну компанію за цим посиланням. Вставте посилання «Поділитися» з картки конкретної компанії.',
      );
    const placeId = parsed.data.entities[0].place.slice(7);
    await finish('done', {
      placeId,
      sourceUrl: input.sourceUrl,
      costUsd: limits.priceUsd,
    });
    return { placeId, receiptId: receipt.id as string };
  } catch (error) {
    const failure =
      error instanceof TaskFailure
        ? error
        : new TaskFailure(
            'google_resolve_network',
            'Не вдалося отримати відповідь Google у відведений час. Перевірте з’єднання й повторіть аналіз.',
          );
    await finish('failed', { costUsd: limits.priceUsd }, failure);
    throw failure;
  }
  async function finish(status: string, result: object, failure?: TaskFailure) {
    await transaction(async (client) => {
      // Resolution is documented as free, including failed attempts. It has its
      // own durable receipt and never consumes the paid Place Details task ID.
      await client.query(
        `insert into spend_events(service_code,units,cost_usd,task_id,meta) values('google_places',1,$1,$2,$3) on conflict(task_id) do nothing`,
        [
          limits.priceUsd,
          receipt.id,
          {
            operation: 'resolveMapsUrls',
            costBasis: 'documented_free_sku',
            ...(failure ? { reasonCode: failure.code } : {}),
          },
        ],
      );
      await client.query(
        `update tasks set status=$2::text::task_status,result=$3,reason_code=$4,reason_uk=$5,finished_at=now(),dismissed_at=case when $2='failed' then now() else null end where id=$1`,
        [
          receipt.id,
          status,
          result,
          failure?.code ?? null,
          failure?.reasonUk ?? null,
        ],
      );
    });
  }
}
