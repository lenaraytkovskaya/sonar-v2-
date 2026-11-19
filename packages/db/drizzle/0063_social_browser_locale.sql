INSERT INTO settings(key,value) VALUES ('social.browser.locale','"en-US"'::jsonb)
ON CONFLICT (key) DO NOTHING;
