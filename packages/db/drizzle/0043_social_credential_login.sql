INSERT INTO settings(key,value) VALUES
('social.login.daily_limit','3'),
('social.login.relogin_cooldown_hours','6'),
('social.login.code_timeout_seconds','600'),
('tasks.social.session.login','{"retryLimit":0,"retryDelay":30,"expireInSeconds":1200}')
ON CONFLICT(key) DO NOTHING;
