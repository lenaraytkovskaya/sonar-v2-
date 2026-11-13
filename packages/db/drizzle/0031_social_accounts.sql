ALTER TABLE channel_accounts DROP CONSTRAINT account_channel;
ALTER TABLE channel_accounts ADD CONSTRAINT account_channel CHECK (channel in ('email','telegram','whatsapp','form','instagram','facebook','linkedin'));
--> statement-breakpoint
INSERT INTO settings(key,value) VALUES
('social.send.min_gap_seconds','120'),
('social.send.max_gap_seconds','300'),
('tasks.social.session.check','{"retryLimit":0,"retryDelay":30,"expireInSeconds":300}')
ON CONFLICT(key) DO NOTHING;
