INSERT INTO settings(key,value) VALUES
  ('social.inbox.listen_enabled','true'::jsonb),
  ('social.inbox.listen_min_gap_seconds','15'::jsonb)
ON CONFLICT (key) DO NOTHING;
