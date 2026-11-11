CREATE TABLE "channel_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"owner_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"daily_limit" integer NOT NULL,
	"sent_day" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_send_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_daily_limit" CHECK ("channel_accounts"."daily_limit" > 0)
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"contact_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_company_campaign_channel" UNIQUE("company_id","campaign_id","channel")
);
--> statement-breakpoint
CREATE TABLE "do_not_contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"kind" text NOT NULL,
	"value_normalized" text NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "do_not_contact_target" UNIQUE("kind","value_normalized"),
	CONSTRAINT "block_kind" CHECK ("do_not_contact"."kind" in ('company','email','domain','phone','telegram','whatsapp','viber','form'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"direction" text DEFAULT 'out' NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"to_value" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_snapshot" jsonb,
	"first_attempt_at" timestamp with time zone,
	"quota_day" text,
	"provider_id" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_by" uuid,
	"reason_uk" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "messages_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "message_status" CHECK ("messages"."status" in ('draft','awaiting_approval','queued','sent','delivered','read','failed'))
);
--> statement-breakpoint
ALTER TABLE "channel_accounts" ADD CONSTRAINT "channel_accounts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "do_not_contact" ADD CONSTRAINT "do_not_contact_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_id_channel_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE do_not_contact ADD CONSTRAINT do_not_contact_company_id_companies_id_fk FOREIGN KEY(company_id) REFERENCES companies(id);
--> statement-breakpoint
INSERT INTO settings(key,value) VALUES
('send.hours','{"start":9,"end":18,"days":[1,2,3,4,5]}'),
('send.time_zones','{"UA":"Europe/Kyiv","PL":"Europe/Warsaw","DE":"Europe/Berlin","GB":"Europe/London","FR":"Europe/Paris","CZ":"Europe/Prague","SK":"Europe/Bratislava","RO":"Europe/Bucharest"}'),
('send.min_gap_seconds','60'),('send.max_gap_seconds','180'),
('tasks.message.send','{"retryLimit":3,"retryDelay":60,"expireInSeconds":120}')
ON CONFLICT(key) DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION protect_email_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.first_attempt_at IS NOT NULL AND
    (NEW.request_snapshot IS DISTINCT FROM OLD.request_snapshot OR NEW.first_attempt_at IS DISTINCT FROM OLD.first_attempt_at OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.to_value IS DISTINCT FROM OLD.to_value OR NEW.subject IS DISTINCT FROM OLD.subject OR NEW.body IS DISTINCT FROM OLD.body)
  THEN RAISE EXCEPTION 'Email request is immutable after first attempt'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER immutable_email_request BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION protect_email_request();

--> statement-breakpoint
ALTER TABLE channel_accounts ADD CONSTRAINT account_channel CHECK(channel in ('email','telegram','whatsapp','form'));
--> statement-breakpoint
ALTER TABLE messages ADD CONSTRAINT message_direction CHECK(direction in ('out','in'));
--> statement-breakpoint
ALTER TABLE messages ADD CONSTRAINT message_channel CHECK(channel in ('email','telegram','whatsapp','form'));
