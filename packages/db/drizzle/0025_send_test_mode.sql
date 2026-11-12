INSERT INTO "settings" ("key", "value") VALUES
('send.test_mode', 'true'::jsonb),
('send.test_allowlist', '[]'::jsonb)
ON CONFLICT ("key") DO NOTHING;
