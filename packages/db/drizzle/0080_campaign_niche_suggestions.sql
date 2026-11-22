-- Keep custom search guidance; make the current output contract niche-only.
UPDATE settings SET value=jsonb_set(value,'{campaign}',to_jsonb((value->>'campaign') || E'\n' ||
  '[campaign-niche-v1] For campaign creation, return ONLY JSON {"name":"...","country_code":"UA","language_code":"uk","cities":["..."],"queries":["..."]}. Suggest recipient niches, cities and business-only search queries. The campaign offer/outreach_goal/needs_about output fields are obsolete: never generate a product, offer, sales text, conditions or product_id. The person selects an existing product separately. Sender company.about is not required and must not define the recipient niche.')),
  updated_at=now() WHERE key='ai.actions' AND jsonb_typeof(value->'campaign')='string'
  AND strpos(value->>'campaign','[campaign-niche-v1]')=0;
