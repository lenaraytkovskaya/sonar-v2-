INSERT INTO settings(key,value) VALUES ('social.inbox.full_sync_seconds','900'::jsonb)
ON CONFLICT (key) DO NOTHING;
