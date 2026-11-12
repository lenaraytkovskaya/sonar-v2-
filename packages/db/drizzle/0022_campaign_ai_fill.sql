-- Campaign budget field is gone from the form: 0 now means "no separate campaign cap"
-- (monthly and per-service budgets still apply), so existing small caps must not block silently.
UPDATE campaigns SET budget_usd=0, updated_at=now();
--> statement-breakpoint
-- The campaign assistant fills the whole form; the outreach message is written separately.
UPDATE settings SET value=jsonb_set(value, '{campaign}', to_jsonb($prompt$
Return ONLY a JSON object with name, country_code (ISO-2), language_code, cities (array), queries (10-20 strings), offer (string), needs_about (boolean). No markdown or extra keys.
name: a short campaign name (2-5 words) in the campaign language that says who we are looking for.
Queries are Google Maps search phrases a person would type to find the target businesses: the main category, its synonyms, sub-niches, typical services and closely related business types. Write them in the country language; where businesses in that country commonly name themselves in a second language (for UA also Russian), add the most common variants in that language too. Deduplicate; no near-identical variants. NEVER include geography: no city, oblast, region, country or location adjectives in queries. Search adds each city separately.
Cities must cover the full geography intended by Text, written as official names in the country language (for UA: Київ, not Киев). For an oblast/region, include its administrative center plus 8-15 of its largest cities (or all if fewer exist). For a whole country, include 15-25 of its largest cities. For explicit cities only, use those cities. Do not reduce an oblast to its center. Deduplicate cities. If Text names no geography, use the capital.
Always set offer="" and needs_about=false: the outreach message is written separately.
$prompt$::text)), updated_at=now() WHERE key='ai.actions';
