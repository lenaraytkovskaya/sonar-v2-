INSERT INTO settings(key,value) VALUES ('send.reply_duplicate_window_seconds','120'::jsonb)
ON CONFLICT (key) DO NOTHING;
