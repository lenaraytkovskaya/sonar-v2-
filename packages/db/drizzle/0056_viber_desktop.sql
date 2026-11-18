ALTER TABLE channel_accounts DROP CONSTRAINT account_channel;
ALTER TABLE channel_accounts ADD CONSTRAINT account_channel
  CHECK (channel IN ('email','telegram','whatsapp','viber','form','instagram','facebook','linkedin'));
ALTER TABLE messages DROP CONSTRAINT message_channel;
ALTER TABLE messages ADD CONSTRAINT message_channel
  CHECK (channel IN ('email','telegram','whatsapp','viber','form','social','call'));
CREATE UNIQUE INDEX channel_accounts_viber_singleton ON channel_accounts(channel) WHERE channel='viber';
INSERT INTO channel_accounts(channel,name,address,daily_limit,status,settings)
VALUES ('viber','Viber Desktop','',20,'active','{}') ON CONFLICT DO NOTHING;
INSERT INTO settings(key,value) VALUES
 ('send.viber.min_gap_seconds','60'),
 ('send.viber.max_gap_seconds','180'),
 ('viber.inbox.poll_seconds','60'),
 ('tasks.viber.inbox.sync','{"retryLimit":0,"retryDelay":30,"expireInSeconds":600}')
ON CONFLICT(key) DO NOTHING;
