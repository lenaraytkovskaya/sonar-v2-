ALTER TABLE conversations ADD COLUMN provider_thread_id text;
ALTER TABLE messages ADD COLUMN external_message_id text;
ALTER TABLE messages ADD COLUMN social_meta jsonb;
ALTER TABLE do_not_contact DROP CONSTRAINT block_kind;
ALTER TABLE do_not_contact ADD CONSTRAINT block_kind CHECK(kind IN ('company','email','domain','phone','telegram','whatsapp','viber','form','social'));
--> statement-breakpoint
ALTER TABLE conversations DROP CONSTRAINT conversation_company_campaign_contact_channel;
CREATE UNIQUE INDEX conversation_company_campaign_contact_channel ON conversations(company_id,campaign_id,contact_id,channel) WHERE provider_thread_id IS NULL;
DROP INDEX conversation_inbound_peer;
CREATE UNIQUE INDEX conversation_inbound_peer ON conversations(account_id,channel,peer_value) WHERE peer_value IS NOT NULL AND provider_thread_id IS NULL;
CREATE UNIQUE INDEX conversation_social_thread ON conversations(account_id,provider_thread_id) WHERE channel='social' AND provider_thread_id IS NOT NULL;
DROP INDEX message_inbound_provider;
CREATE UNIQUE INDEX message_inbound_provider ON messages(channel,account_id,provider_id) WHERE direction='in' AND channel<>'social';
CREATE UNIQUE INDEX message_social_external ON messages((social_meta->>'network'),account_id,external_message_id) WHERE channel='social' AND external_message_id IS NOT NULL;
CREATE UNIQUE INDEX social_inbox_one_account_job ON tasks((payload->>'accountId')) WHERE type='social.inbox.sync' AND status IN ('queued','running');
--> statement-breakpoint
INSERT INTO settings(key,value) VALUES
('social.inbox.enabled','false'),
('social.inbox.poll_seconds','180'),
('social.inbox.daily_limit','480'),
('social.action.min_gap_seconds','120'),
('tasks.social.inbox.sync','{"retryLimit":0,"retryDelay":30,"expireInSeconds":600}')
ON CONFLICT(key) DO NOTHING;
