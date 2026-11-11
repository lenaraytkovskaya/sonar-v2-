-- Update only the campaign instruction; preserve other configured AI actions.
UPDATE settings SET value=jsonb_set(value, '{campaign}', to_jsonb($prompt$
Return ONLY a JSON object with name, country_code (ISO-2), language_code, cities (array), queries (5-10 strings), offer (string), needs_about (boolean). No markdown or extra keys.
Queries are business categories and synonyms ONLY in the country language. NEVER include geography: no city, oblast, region, country or location adjectives in queries. Search adds each city separately.
Cities must cover the full geography intended by Text. For an oblast/region, include its administrative center plus 8-15 of its largest cities (or all if fewer exist). For a whole country, include 15-25 of its largest cities. For explicit cities only, use those cities. Do not reduce an oblast to its center. Deduplicate cities.
Offer is a ready-to-edit FIRST outreach message to the target business, based ONLY on sender facts in company.about, in the campaign language. Text describes recipients, not the sender: never repeat it as the offer or invent sender products, services, experience, names, prices or promises. If company.about is missing or blank, set offer="" and needs_about=true. Otherwise set needs_about=false and write a concise factual draft with a greeting and a relevant question.
$prompt$::text)), updated_at=now() WHERE key='ai.actions';
