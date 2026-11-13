-- Analyses were cut off at 2000 tokens; give the model room and a matching cost cap.
UPDATE settings SET value='4000', updated_at=now() WHERE key='analysis.max_tokens' AND value='2000'::jsonb;
--> statement-breakpoint
UPDATE settings SET value='0.006', updated_at=now() WHERE key='analysis.max_usd' AND value='0.003'::jsonb;
