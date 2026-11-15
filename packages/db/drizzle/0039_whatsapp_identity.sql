ALTER TABLE conversations ADD COLUMN merged_into_id uuid CONSTRAINT conversations_merged_into_id_conversations_id_fk REFERENCES conversations(id);
ALTER TABLE conversations ADD COLUMN peer_aliases text[] NOT NULL DEFAULT '{}';
ALTER TABLE conversations ADD CONSTRAINT conversation_merge_not_self CHECK (merged_into_id <> id);
DROP INDEX conversation_inbound_peer;
CREATE UNIQUE INDEX conversation_inbound_peer ON conversations(account_id,channel,peer_value) WHERE peer_value IS NOT NULL AND provider_thread_id IS NULL AND merged_into_id IS NULL;
DROP INDEX conversation_company_campaign_contact_channel;
CREATE UNIQUE INDEX conversation_company_campaign_contact_channel ON conversations(company_id,campaign_id,contact_id,channel) WHERE provider_thread_id IS NULL AND channel <> 'whatsapp';
--> statement-breakpoint
INSERT INTO settings(key,value) VALUES ('tasks.whatsapp.identity.repair','{"retryLimit":2,"retryDelay":30,"expireInSeconds":120}') ON CONFLICT(key) DO NOTHING;

--> statement-breakpoint
-- Permit only the conversation association to follow an existing same-account WhatsApp redirect.
-- Every provider request field remains immutable, including its original snapshot.
CREATE OR REPLACE FUNCTION protect_email_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.first_attempt_at IS NOT NULL AND (
    NEW.request_snapshot IS DISTINCT FROM OLD.request_snapshot OR
    NEW.first_attempt_at IS DISTINCT FROM OLD.first_attempt_at OR
    NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR
    NEW.account_id IS DISTINCT FROM OLD.account_id OR
    NEW.to_value IS DISTINCT FROM OLD.to_value OR
    NEW.subject IS DISTINCT FROM OLD.subject OR
    NEW.body IS DISTINCT FROM OLD.body OR
    NEW.channel IS DISTINCT FROM OLD.channel OR
    (NEW.conversation_id IS DISTINCT FROM OLD.conversation_id AND NOT (
      OLD.channel='whatsapp' AND EXISTS (
        SELECT 1 FROM conversations old_thread JOIN conversations new_thread ON new_thread.id=old_thread.merged_into_id
        WHERE old_thread.id=OLD.conversation_id AND new_thread.id=NEW.conversation_id
          AND old_thread.channel='whatsapp' AND new_thread.channel='whatsapp'
          AND new_thread.account_id=OLD.account_id
          AND (old_thread.account_id IS NULL OR old_thread.account_id=OLD.account_id)
      )
    ))
  ) THEN RAISE EXCEPTION 'Message request is immutable after first attempt'; END IF;
  RETURN NEW;
END $$;
