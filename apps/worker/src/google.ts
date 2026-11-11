import {
  createGoogleClient,
  normalizePhone,
  normalizeWebsite,
  googlePageSchema,
  BudgetExceeded,
  type GoogleSearch,
  type GoogleProfile,
  type GooglePage,
} from '@sonar/core';
import { sonarPool } from '@sonar/db';
import { recordGooglePage, type BatchConfig } from '@sonar/db/batches';
import { runBudgetedRequest, BillingUncertain } from '@sonar/db/budget';
import { boss, runTask, logActivity, type TaskOutcome } from '@sonar/db/tasks';
import type { CountryCode } from '@sonar/core';
type Search = (
  input: GoogleSearch,
  profile: GoogleProfile,
) => Promise<GooglePage>;
// A batch lock excludes duplicate deliveries; monetary locks are only held during reservations.
export async function runGoogleBatch(
  batchId: string,
  search?: Search,
): Promise<TaskOutcome> {
  const client = await sonarPool.connect();
  const {
    rows: [lock],
  } = await client.query(
    'select pg_try_advisory_lock(hashtextextended($1,0)) as locked',
    [batchId],
  );
  if (!lock.locked) {
    client.release();
    return {
      status: 'paused',
      reasonCode: 'batch_busy',
      reasonUk: 'Порція вже виконується.',
    };
  }
  try {
    const {
      rows: [initial],
    } = await client.query('select * from batches where id=$1', [batchId]);
    if (!initial) throw Error('Batch missing');
    if (initial.status === 'done')
      return { status: 'done', result: { batchId } };
    if (initial.fixture && !search)
      throw Error('Fixture requires an explicit stub');
    if (!search && !process.env.GOOGLE_PLACES_API_KEY)
      return await pause(
        'api_key_missing',
        'Додайте ключ Google Places у налаштування стенда.',
      );
    search ??= createGoogleClient(process.env.GOOGLE_PLACES_API_KEY!);
    const config = initial.config as BatchConfig;
    const pairs = config.queries.flatMap((query) =>
      config.cities.map((city) => ({ query, city })),
    );
    await client.query(
      "update batches set status='running',reason_uk=null,started_at=coalesce(started_at,now()),finished_at=null where id=$1",
      [batchId],
    );
    while (true) {
      const {
        rows: [batch],
      } = await client.query(
        'select b.*,c.status as campaign_status from batches b join campaigns c on c.id=b.campaign_id where b.id=$1',
        [batchId],
      );
      if (
        batch.campaign_status === 'paused' ||
        batch.campaign_status === 'archived'
      )
        return await pause('campaign_paused', 'Кампанію призупинено.');
      const cursor = batch.cursor as {
        pair: number;
        page: number;
        token?: string;
      };
      if (
        batch.found_new + batch.found_known >= batch.size ||
        cursor.pair >= pairs.length
      ) {
        const reason =
          cursor.pair >= pairs.length ? 'Результати вичерпано.' : null;
        await client.query(
          "update batches set status='done',reason_uk=$2,finished_at=now() where id=$1",
          [batchId, reason],
        );
        await logActivity(
          'batch.done',
          'batch',
          batchId,
          null,
          { campaignId: batch.campaign_id },
          client,
        );
        return {
          status: 'done',
          result: {
            batchId,
            foundNew: batch.found_new,
            foundKnown: batch.found_known,
          },
        };
      }
      const key = `google.request:${batchId}:${cursor.pair}:${cursor.page}`;
      const {
        rows: [task],
      } = await client.query(
        `insert into tasks(type,idempotency_key,batch_id,subject_type,subject_id) values('google.request',$1,$2::uuid,'batch',$2::text) on conflict(idempotency_key) do update set idempotency_key=excluded.idempotency_key returning id`,
        [key, batchId],
      );
      const pair = pairs[cursor.pair]!;
      let page: GooglePage;
      try {
        if (batch.fixture) {
          page = googlePageSchema.parse(
            await search(
              {
                textQuery: `${pair.query} ${pair.city}`,
                languageCode: config.language_code,
                regionCode: config.country_code,
                pageSize: 20,
                ...(cursor.token ? { pageToken: cursor.token } : {}),
              },
              config.profile,
            ),
          );
        } else {
          const response = await runBudgetedRequest(
            'google_places',
            config.profile.priceUsd,
            task.id,
            async () => {
              await client.query(
                "update tasks set attempts=attempts+1,status='running',started_at=now() where id=$1",
                [task.id],
              );
              const data = await search!(
                {
                  textQuery: `${pair.query} ${pair.city}`,
                  languageCode: config.language_code,
                  regionCode: config.country_code,
                  pageSize: 20,
                  ...(cursor.token ? { pageToken: cursor.token } : {}),
                },
                config.profile,
              );
              return {
                id: task.id,
                model: config.profile.sku,
                text: JSON.stringify(data),
                units: 1,
                costUsd: config.profile.priceUsd,
                costBasis: 'estimated_tariff',
              };
            },
          );
          page = googlePageSchema.parse(JSON.parse(response.text));
        }
      } catch (error) {
        if (
          error instanceof BudgetExceeded ||
          error instanceof BillingUncertain
        ) {
          await client.query(
            "update tasks set status='paused',reason_uk=$2,finished_at=now() where id=$1",
            [task.id, error.message],
          );
          return await pause(
            error instanceof BudgetExceeded
              ? 'budget_exceeded'
              : 'billing_uncertain',
            error.message,
          );
        }
        await client.query(
          "update tasks set status='paused',reason_uk=$2,finished_at=now() where id=$1",
          [
            task.id,
            'Запит Google не завершено. Перед повтором звірте можливі витрати.',
          ],
        );
        return await pause(
          'google_request_failed',
          'Запит Google не завершено. Перед повтором звірте можливі витрати.',
        );
      }
      await recordGooglePage(client, batchId, async (tx) => {
        let foundNew = 0,
          foundKnown = 0;
        for (const place of page.places) {
          if (
            batch.found_new + batch.found_known + foundNew + foundKnown >=
            batch.size
          )
            break;
          if (place.businessStatus === 'CLOSED_PERMANENTLY') continue;
          const site = normalizeWebsite(place.websiteUri);
          const city =
            place.addressComponents?.find((c) => c.types.includes('locality'))
              ?.longText ?? pair.city;
          const country =
            place.addressComponents?.find((c) => c.types.includes('country'))
              ?.shortText ?? config.country_code;
          const {
            rows: [company],
          } = await tx.query(
            `insert into companies(place_id,name,primary_type,types,address,city,country_code,lat,lng,website,domain,google_maps_uri,rating,ratings_count,business_status,google_expires_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now()+$16*interval '1 day')
      on conflict(place_id) do update set name=excluded.name,primary_type=excluded.primary_type,types=excluded.types,address=excluded.address,city=excluded.city,country_code=excluded.country_code,lat=excluded.lat,lng=excluded.lng,website=coalesce(excluded.website,companies.website),domain=coalesce(excluded.domain,companies.domain),google_maps_uri=excluded.google_maps_uri,rating=coalesce(excluded.rating,companies.rating),ratings_count=coalesce(excluded.ratings_count,companies.ratings_count),business_status=excluded.business_status,google_expires_at=excluded.google_expires_at,updated_at=now() returning id,(xmax=0) as created`,
            [
              place.id,
              place.displayName?.text ?? place.id,
              place.primaryType ?? null,
              place.types ?? [],
              place.formattedAddress ?? null,
              city,
              country,
              place.location?.latitude ?? null,
              place.location?.longitude ?? null,
              site?.website ?? null,
              site?.domain ?? null,
              place.googleMapsUri ?? null,
              place.rating ?? null,
              place.userRatingCount ?? null,
              place.businessStatus ?? null,
              config.retentionDays,
            ],
          );
          const link = await tx.query(
            'insert into campaign_companies(campaign_id,company_id,batch_id) values($1,$2,$3) on conflict do nothing returning company_id',
            [batch.campaign_id, company.id, batchId],
          );
          const phone = normalizePhone(
            place.internationalPhoneNumber ?? place.nationalPhoneNumber ?? '',
            config.country_code as CountryCode,
          );
          for (const [kind, value, normalized] of [
            ['website', site?.website, site?.domain],
            [
              'phone',
              place.internationalPhoneNumber ?? place.nationalPhoneNumber,
              phone,
            ],
          ]) {
            if (value && normalized)
              await tx.query(
                `insert into contacts(company_id,kind,value,normalized,source,source_url,rank) values($1,$2,$3,$4,'google',$5,10) on conflict(company_id,kind,normalized) do update set found_at=now(),source_url=excluded.source_url where contacts.source='google'`,
                [
                  company.id,
                  kind,
                  value,
                  normalized,
                  place.googleMapsUri ?? null,
                ],
              );
          }
          if (link.rowCount) {
            if (company.created) foundNew++;
            else foundKnown++;
            await logActivity(
              'company.found',
              'company',
              company.id,
              null,
              {
                campaignId: batch.campaign_id,
                batchId,
                source: 'google',
                fixture: batch.fixture,
              },
              tx,
            );
          }
        }
        const next =
          page.nextPageToken && cursor.page < 2
            ? {
                pair: cursor.pair,
                page: cursor.page + 1,
                token: page.nextPageToken,
              }
            : { pair: cursor.pair + 1, page: 0 };
        await tx.query(
          `update tasks set status='done',finished_at=now(),result=coalesce(result,'{}')||$2::jsonb where id=$1`,
          [task.id, JSON.stringify({ fixture: batch.fixture })],
        );
        await tx.query(
          `update batches set found_new=found_new+$2,found_known=found_known+$3,requests=requests+$4,cost_usd=cost_usd+$5,cursor=$6 where id=$1`,
          [
            batchId,
            foundNew,
            foundKnown,
            batch.fixture ? 0 : 1,
            batch.fixture ? 0 : config.profile.priceUsd,
            next,
          ],
        );
      });
    }
  } catch (error) {
    await client.query(
      "update batches set status='failed',reason_uk=$2,finished_at=now() where id=$1",
      [
        batchId,
        'Не вдалося обробити порцію. Повторіть після перевірки журналу.',
      ],
    );
    throw error;
  } finally {
    await client.query('select pg_advisory_unlock(hashtextextended($1,0))', [
      batchId,
    ]);
    client.release();
  }
  async function pause(code: string, reason: string): Promise<TaskOutcome> {
    await client.query(
      "update batches set status='paused',reason_uk=$2,finished_at=now() where id=$1",
      [batchId, reason],
    );
    return { status: 'paused', reasonCode: code, reasonUk: reason };
  }
}
export async function registerGoogleTasks() {
  await boss.createQueue('google.batch');
  await runTask('google.batch', async (payload) =>
    runGoogleBatch((payload as { batchId: string }).batchId),
  );
}
