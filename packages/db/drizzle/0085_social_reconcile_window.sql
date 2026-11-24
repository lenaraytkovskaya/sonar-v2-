INSERT INTO settings(key,value) VALUES ('social.inbox.reconcile_window_seconds','1800'::jsonb)
ON CONFLICT (key) DO NOTHING;
