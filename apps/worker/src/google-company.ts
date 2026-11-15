import {
  contactFields,
  googlePageSchema,
  manualGoogleMaps,
  normalizeWebsite,
  normalizePhone,
  BudgetExceeded,
  PaidHttpError,
  type CountryCode,
} from '@sonar/core';
import { sonarPool } from '@sonar/db';
import { transaction } from '@sonar/db/email';
import {
  runBudgetedRequest,
  BillingUncertain,
  paidErrorReason,
} from '@sonar/db/budget';
import { TaskFailure, type TaskOutcome } from '@sonar/db/tasks';

export type GoogleCompanyPayload = {
  companyId: string;
  campaignId: string;
  sourceUrl: string;
  placeId: string;
};
// Fixed Google API endpoint, no fetching or redirect resolution of user-supplied URLs.
export async function runGoogleCompany(
  payload: GoogleCompanyPayload,
  taskId: string,
  fetcher: typeof fetch = fetch,
): Promise<TaskOutcome> {
  const target = manualGoogleMaps(payload.sourceUrl);
  if (!target || target.placeId !== payload.placeId)
    throw new TaskFailure(
      'google_source_invalid',
      'Некоректне джерело Google Maps.',
    );
  const {
    rows: [company],
  } = await sonarPool.query(
    'select google_maps_uri,country_code from companies where id=$1',
    [payload.companyId],
  );
  const stale = () => ({
    status: 'skipped' as const,
    reasonCode: 'source_changed',
    reasonUk:
      'Посилання Google Maps змінено. Застарілі результати не збережено.',
  });
  if (company?.google_maps_uri !== payload.sourceUrl) return stale();
  const { rows } = await sonarPool.query(
    "select key,value from settings where key in ('google.details.price_usd','scanner.timeout_ms','retention.google_days')",
  );
  const config = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const price = Number(config['google.details.price_usd']);
  const timeout = Number(config['scanner.timeout_ms']);
  const days = Number(config['retention.google_days']);
  if (
    !Number.isFinite(price) ||
    price < 0 ||
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    !Number.isSafeInteger(days) ||
    days <= 0
  )
    throw new TaskFailure(
      'google_config_invalid',
      'Перевірте тариф і налаштування Google Places.',
    );
  if (!process.env.GOOGLE_PLACES_API_KEY && fetcher === fetch)
    return {
      status: 'paused',
      reasonCode: 'api_key_missing',
      reasonUk: 'Додайте ключ Google Places перед аналізом.',
    };
  try {
    const billed = await runBudgetedRequest(
      'google_places',
      price,
      taskId,
      async () => {
        const response = await fetcher(
          `https://places.googleapis.com/v1/places/${encodeURIComponent(payload.placeId)}`,
          {
            redirect: 'error',
            signal: AbortSignal.timeout(timeout),
            headers: {
              'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY ?? '',
              'X-Goog-FieldMask': contactFields
                .filter((f) => f.startsWith('places.'))
                .map((f) => f.slice(7))
                .join(','),
            },
          },
        );
        if (!response.ok) throw new PaidHttpError(response.status);
        return {
          id: taskId,
          model: 'Place Details Enterprise',
          text: await response.text(),
          units: 1,
          costUsd: price,
          costBasis: 'estimated_tariff' as const,
        };
      },
    );
    const place = googlePageSchema.parse({ places: [JSON.parse(billed.text)] })
      .places[0]!;
    if (place.id !== payload.placeId)
      throw new TaskFailure(
        'google_place_mismatch',
        'Google повернув інший Place ID. Дані не збережено.',
      );
    return await transaction(async (client) => {
      const {
        rows: [current],
      } = await client.query(
        'select google_maps_uri from companies where id=$1 for update',
        [payload.companyId],
      );
      if (current?.google_maps_uri !== payload.sourceUrl) return stale();
      // Keep the CRM identity and all prior snapshots. Google is evidence, not an identity replacement.
      await client.query(
        `insert into company_facts(company_id,kind,value,source,source_url,expires_at) values($1,'google_place',$2,'google',$3,now()+$4*interval '1 day') on conflict(company_id,kind,source,(md5(value::text))) do update set found_at=now(),expires_at=excluded.expires_at`,
        [payload.companyId, JSON.stringify(place), payload.sourceUrl, days],
      );
      const site = normalizeWebsite(place.websiteUri);
      if (site)
        await client.query(
          `insert into company_facts(company_id,kind,value,source,source_url,expires_at) values($1,'website_candidate',$2,'google',$3,now()+$4*interval '1 day') on conflict(company_id,kind,source,(md5(value::text))) do update set found_at=now(),source_url=excluded.source_url,expires_at=excluded.expires_at`,
          [
            payload.companyId,
            JSON.stringify(site.website),
            payload.sourceUrl,
            days,
          ],
        );
      const phone = normalizePhone(
        place.internationalPhoneNumber ?? place.nationalPhoneNumber ?? '',
        company.country_code as CountryCode,
      );
      if (phone)
        await client.query(
          `insert into contacts(company_id,kind,value,normalized,source,source_url) values($1,'phone',$2,$2,'google',$3) on conflict(company_id,kind,normalized) do nothing`,
          [payload.companyId, phone, payload.sourceUrl],
        );
      return {
        status: 'done' as const,
        result: {
          placeId: place.id,
          sourceUrl: payload.sourceUrl,
          name: place.displayName?.text ?? '',
          address: place.formattedAddress ?? '',
          website: site?.website ?? null,
        },
      };
    });
  } catch (error) {
    if (error instanceof BudgetExceeded || error instanceof BillingUncertain)
      return {
        status: 'paused',
        reasonCode:
          error instanceof BillingUncertain
            ? 'billing_uncertain'
            : 'budget_exceeded',
        reasonUk: error.message,
      };
    if (error instanceof PaidHttpError)
      throw new TaskFailure('google_http_error', paidErrorReason(error.status));
    throw error;
  }
}
