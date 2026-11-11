-- Preserve the configured rewrite cap; never lower it for structured actions.
UPDATE settings SET value=jsonb_build_object(
  'rewrite', value,
  'campaign', greatest((value #>> '{}')::integer, 2000),
  'company_filters', greatest((value #>> '{}')::integer, 800)
), updated_at=now()
WHERE key='ai.max_tokens' AND jsonb_typeof(value)='number';
