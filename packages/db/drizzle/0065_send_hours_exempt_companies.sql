INSERT INTO settings(key,value) VALUES ('send.hours_exempt_company_ids','[]'::jsonb)
ON CONFLICT (key) DO NOTHING;
