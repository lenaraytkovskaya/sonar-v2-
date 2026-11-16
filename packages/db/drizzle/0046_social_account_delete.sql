CREATE OR REPLACE FUNCTION protect_email_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.first_attempt_at IS NOT NULL AND (
    NEW.request_snapshot IS DISTINCT FROM OLD.request_snapshot OR
    NEW.first_attempt_at IS DISTINCT FROM OLD.first_attempt_at OR
    NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR
    (NEW.account_id IS DISTINCT FROM OLD.account_id AND NOT (
      OLD.channel='social' AND NEW.account_id IS NULL AND
      current_setting('sonar.social_account_deleting', true)=OLD.account_id::text AND
      EXISTS(SELECT 1 FROM channel_accounts a WHERE a.id=OLD.account_id AND a.channel IN ('facebook','instagram','linkedin'))
    )) OR
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
