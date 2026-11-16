-- Owner decision 16.11.2026: long site texts used the whole 0.006 USD cap and answers were cut off.
UPDATE settings SET value='0.02', updated_at=now() WHERE key='analysis.max_usd' AND value='0.006'::jsonb;
