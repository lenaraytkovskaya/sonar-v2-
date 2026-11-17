-- Move sender identity into shared contact settings, preserving existing values.
INSERT INTO settings(key,value)
SELECT 'contact.' || f.key, to_jsonb(coalesce((
  SELECT CASE f.key WHEN 'name' THEN a.settings->>'senderName'
    WHEN 'email' THEN a.address WHEN 'phone' THEN a.settings->>'senderPhone' END
  FROM channel_accounts a
  WHERE a.channel='form' AND nullif(btrim(CASE f.key WHEN 'name' THEN a.settings->>'senderName'
    WHEN 'email' THEN a.address WHEN 'phone' THEN a.settings->>'senderPhone' END),'') IS NOT NULL
  ORDER BY a.created_at,a.id LIMIT 1
),''))
FROM (VALUES ('name'),('email'),('phone'),('whatsapp'),('telegram'),('website')) f(key)
ON CONFLICT(key) DO UPDATE SET value=excluded.value
WHERE settings.value IS NULL OR settings.value='null'::jsonb
   OR (jsonb_typeof(settings.value)='string' AND btrim(settings.value #>> '{}')='');
--> statement-breakpoint
UPDATE channel_accounts SET address='',settings=settings-'senderName'-'senderPhone' WHERE channel='form';
