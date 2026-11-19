INSERT INTO settings(key,value) VALUES
  ('social.browser.max_profiles','3'::jsonb),
  ('social.browser.idle_ms','1800000'::jsonb)
ON CONFLICT (key) DO NOTHING;
