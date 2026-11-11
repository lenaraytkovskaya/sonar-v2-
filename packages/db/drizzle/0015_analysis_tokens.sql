-- 900 output tokens truncate Ukrainian summaries plus a first message on Haiku-class models.
UPDATE settings SET value='2000', updated_at=now() WHERE key='analysis.max_tokens' AND value='900'::jsonb;
--> statement-breakpoint
-- A new analysis version lets companies whose analysis failed on the old limit be analysed again.
UPDATE settings SET value=to_jsonb(((value #>> '{}')::integer + 1)::text), updated_at=now() WHERE key='analysis.version' AND (value #>> '{}') ~ '^[0-9]+$';
