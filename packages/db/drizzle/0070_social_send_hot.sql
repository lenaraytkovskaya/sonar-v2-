INSERT INTO settings(key,value) VALUES ('social.send.hot_enabled','true'::jsonb)
ON CONFLICT (key) DO NOTHING;
