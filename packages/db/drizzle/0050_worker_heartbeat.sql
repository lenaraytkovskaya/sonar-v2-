INSERT INTO settings(key,value) VALUES ('worker.stale_seconds','180')
ON CONFLICT(key) DO NOTHING;
