INSERT INTO settings(key,value) VALUES ('tasks.failure_visible_days','7')
ON CONFLICT(key) DO NOTHING;
