INSERT INTO settings(key,value) VALUES ('social.inbox.listen_sweep_seconds','20'::jsonb)
ON CONFLICT (key) DO NOTHING;
