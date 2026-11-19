UPDATE settings
SET value=to_jsonb((value #>> '{}') || '-campaign-offer'), updated_at=now()
WHERE key='analysis.version'
  AND jsonb_typeof(value)='string'
  AND (value #>> '{}') !~ '(^|-)campaign-offer$';
