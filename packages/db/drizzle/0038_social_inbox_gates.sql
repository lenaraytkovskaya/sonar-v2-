-- Keep both networks disabled until a separate live validation enables them.
INSERT INTO settings(key,value) VALUES
('social.inbox.facebook.enabled','false'),
('social.inbox.instagram.enabled','false')
ON CONFLICT(key) DO NOTHING;
