INSERT INTO settings(key,value) VALUES
('social.auto_password_login','false'),
('social.inbox.timezone','"Europe/Kyiv"')
ON CONFLICT(key) DO NOTHING;
