ALTER TABLE "messages" DROP CONSTRAINT "message_status";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "screenshot_before" "bytea";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "screenshot_after" "bytea";--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "unit_price_usd" numeric(20, 10);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "message_status" CHECK ("messages"."status" in ('draft','awaiting_approval','awaiting_manual','queued','sent','delivered','read','failed'));--> statement-breakpoint
INSERT INTO settings(key,value) VALUES
('send.form_company_daily_limit','1'),
('captcha.provider','"manual"'),
('captcha.poll_ms','5000'),
('captcha.timeout_ms','120000')
ON CONFLICT(key) DO NOTHING;
--> statement-breakpoint
INSERT INTO services(code,name,plan,unit_price_usd) VALUES ('twocaptcha','2Captcha','Pay as you go',0.01) ON CONFLICT(code) DO UPDATE SET unit_price_usd=coalesce(services.unit_price_usd,excluded.unit_price_usd);

--> statement-breakpoint
ALTER TABLE services ADD CONSTRAINT service_price_nonnegative CHECK (unit_price_usd >= 0);

--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_email_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.first_attempt_at IS NOT NULL AND
    (NEW.request_snapshot IS DISTINCT FROM OLD.request_snapshot OR NEW.first_attempt_at IS DISTINCT FROM OLD.first_attempt_at OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.to_value IS DISTINCT FROM OLD.to_value OR NEW.subject IS DISTINCT FROM OLD.subject OR NEW.body IS DISTINCT FROM OLD.body OR NEW.channel IS DISTINCT FROM OLD.channel OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id)
  THEN RAISE EXCEPTION 'Message request is immutable after first attempt'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
UPDATE settings
SET value=value || jsonb_build_object('expireInSeconds',greatest(300,coalesce((value->>'expireInSeconds')::integer,300)))
WHERE key='tasks.message.send';
