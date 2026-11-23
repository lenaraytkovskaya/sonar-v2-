INSERT INTO settings(key,value) VALUES
  ('social.inbox.listen_signal_cooldown_seconds','120'::jsonb)
ON CONFLICT (key) DO NOTHING;
