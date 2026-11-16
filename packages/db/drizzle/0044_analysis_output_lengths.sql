UPDATE settings
SET value = to_jsonb(
  (value #>> '{}') || E'\nKeep summary under 1,200 characters, fit_reason under 1,000 characters, and first_message under 1,200 characters. Preserve the important facts, reasoning, and personalization while staying concise.'
), updated_at = now()
WHERE key = 'analysis.prompt'
  AND jsonb_typeof(value) = 'string'
  AND (value #>> '{}') NOT LIKE '%Keep summary under 1,200 characters%';
