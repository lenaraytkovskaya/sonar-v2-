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
import { readGoogleBody, resolveGoogleMaps } from './google-maps-resolution.js';

export type GoogleCompanyPayload = {
  companyId: string;
  campaignId: string;
  sourceUrl: string;
  placeId: string | null;
  resolveVersion?: number;
};
// Fixed Google API endpoint, no fetching or redirect resolution of user-supplied URLs.
export async function runGoogleCompany(
  payload: GoogleCompanyPayload,
  taskId: string,
  fetcher: typeof fetch = fetch,
): Promise<TaskOutcome> {
  const target = manualGoogleMaps(payload.sourceUrl);
  if (!target || target.placeId !== (payload.placeId ?? null))
    throw new TaskFailure(
      'google_source_invalid',
      'Некоректне джерело Google Maps.',
    );
  const {
    rows: [company],
  } = await sonarPool.query(
    "select google_maps_uri,country_code,(select payload->>'resolveVersion' from tasks where id=$2) as resolve_version from companies where id=$1",
    [payload.companyId, taskId],
  );
  const stale = () => ({
    status: 'skipped' as const,
    reasonCode: 'source_changed',
    reasonUk:
      'Джерело або спробу аналізу Google Maps змінено. Застарілі результати не збережено.',
  });
  if (
    company?.google_maps_uri !== payload.sourceUrl ||
    Number(company.resolve_version ?? 0) !== (payload.resolveVersion ?? 0)
  )
    return stale();
  const { rows } = await sonarPool.query(
    "select key,value from settings where key in ('google.details.price_usd','scanner.timeout_ms','retention.google_days','google.resolve.timeout_ms','google.resolve.max_bytes','google.resolve.price_usd')",
  );
  const config = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const price = Number(config['google.details.price_usd']);
  const timeout = Number(config['scanner.timeout_ms']);
  const days = Number(config['retention.google_days']);
  const maxBytes = Number(config['google.resolve.max_bytes']);
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
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
    let placeId = payload.placeId;
    let resolutionReceiptId: string | undefined;
    if (!placeId) {
      const limits = {
        timeoutMs: Number(config['google.resolve.timeout_ms']),
        maxBytes,
        priceUsd: Number(config['google.resolve.price_usd']),
      };
      if (
        !Number.isSafeInteger(limits.timeoutMs) ||
        limits.timeoutMs <= 0 ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes <= 0 ||
        limits.priceUsd !== 0
      )
        throw new TaskFailure(
          'google_resolve_config',
          'Перевірте ліміти та нульовий тариф визначення місця Google.',
        );
      const resolved = await resolveGoogleMaps(
        payload,
        taskId,
        limits,
        fetcher,
      );
      placeId = resolved.placeId;
      resolutionReceiptId = resolved.receiptId;
      const {
        rows: [current],
      } = await sonarPool.query(
        "select google_maps_uri,(select payload->>'resolveVersion' from tasks where id=$2) as resolve_version from companies where id=$1",
        [payload.companyId, taskId],
      );
      if (
        current?.google_maps_uri !== payload.sourceUrl ||
        Number(current.resolve_version ?? 0) !== (payload.resolveVersion ?? 0)
      )
        return stale();
    }
    // Explicit retries get a new task ID; re-delivery of this attempt reuses its receipt.
    const billed = await runBudgetedRequest(
      'google_places',
      price,
      taskId,
      async () => {
        const response = await fetcher(
          `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
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
          text: await readGoogleBody(response, maxBytes),
          units: 1,
          costUsd: price,
          costBasis: 'estimated_tariff' as const,
        };
      },
    );
    const place = googlePageSchema.parse({ places: [JSON.parse(billed.text)] })
      .places[0]!;
    if (place.id !== placeId)
      throw new TaskFailure(
        'google_place_mismatch',
        'Google повернув інший Place ID. Дані не збережено.',
      );
    return await transaction(async (client) => {
      const {
        rows: [current],
      } = await client.query(
        "select google_maps_uri,(select payload->>'resolveVersion' from tasks where id=$2) as resolve_version from companies where id=$1 for update",
        [payload.companyId, taskId],
      );
      if (
        current?.google_maps_uri !== payload.sourceUrl ||
        Number(current.resolve_version ?? 0) !== (payload.resolveVersion ?? 0)
      )
        return stale();
      // Keep the CRM identity and all prior snapshots. Google is evidence, not an identity replacement.
      await client.query(
        `insert into company_facts(company_id,kind,value,source,source_url,expires_at) values($1,'google_place',$2,'google',$3,now()+$4*interval '1 day') on conflict(company_id,kind,source,(md5(value::text))) do update set found_at=now(),expires_at=excluded.expires_at`,
        [
          payload.companyId,
          JSON.stringify({ ...place, sourceUrl: payload.sourceUrl }),
          payload.sourceUrl,
          days,
        ],
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
          ...(resolutionReceiptId ? { resolutionReceiptId } : {}),
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
    if (
      error instanceof TaskFailure &&
      (error.code.startsWith('google_resolve') ||
        error.code.startsWith('google_response'))
    )
      return {
        status: ['google_resolve_no_place', 'google_resolve_invalid'].includes(
          error.code,
        )
          ? 'skipped'
          : 'paused',
        reasonCode: error.code,
        reasonUk: error.reasonUk,
      };
    if (error instanceof PaidHttpError)
      throw new TaskFailure('google_http_error', paidErrorReason(error.status));
    throw error;
  }
}
