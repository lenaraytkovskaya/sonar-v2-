INSERT INTO settings(key,value) VALUES
('tasks.social.session.keepalive','{"retryLimit":0,"retryDelay":30,"expireInSeconds":600}')
ON CONFLICT(key) DO NOTHING;
