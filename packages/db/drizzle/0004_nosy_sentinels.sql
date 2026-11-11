CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."send_mode" AS ENUM('auto', 'approval', 'manual');--> statement-breakpoint
CREATE TABLE "campaign_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "campaign_presets_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"country_code" text NOT NULL,
	"language_code" text NOT NULL,
	"cities" text[] NOT NULL,
	"queries" text[] NOT NULL,
	"offer" text NOT NULL,
	"batch_size" integer DEFAULT 20 NOT NULL,
	"budget_usd" numeric(20, 10) NOT NULL,
	"channels" jsonb NOT NULL,
	"send_mode" "send_mode" DEFAULT 'approval' NOT NULL,
	"scoring_weights" jsonb NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_budget_nonnegative" CHECK ("campaigns"."budget_usd" >= 0),
	CONSTRAINT "campaign_batch_size" CHECK ("campaigns"."batch_size" in (20,50,100,200))
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT INTO campaign_presets(name,data) VALUES('Авто — Україна','{"country_code": "UA", "language_code": "uk", "cities": ["Київ"], "queries": ["автосервіс"], "offer": "", "batch_size": 20, "budget_usd": 0.5, "channels": {"email": true, "telegram": false, "whatsapp": false, "forms": false}, "send_mode": "approval", "scoring_weights": {"website": 30, "phone": 30, "rating": 40}, "status": "draft", "name": "Авто — Україна"}') ON CONFLICT DO NOTHING;

--> statement-breakpoint
INSERT INTO campaign_presets(name,data) VALUES('Салони краси — Польща','{"country_code": "PL", "language_code": "pl", "cities": ["Warszawa"], "queries": ["salon urody"], "offer": "", "batch_size": 20, "budget_usd": 0.5, "channels": {"email": true, "telegram": false, "whatsapp": false, "forms": false}, "send_mode": "approval", "scoring_weights": {"website": 30, "phone": 30, "rating": 40}, "status": "draft", "name": "Салони краси — Польща"}') ON CONFLICT DO NOTHING;

--> statement-breakpoint
INSERT INTO settings(key,value) VALUES ('tasks.google.batch','{"retryLimit":0,"retryDelay":5,"expireInSeconds":600}');

--> statement-breakpoint
UPDATE settings SET value = value || '{"campaign": "Return ONLY a JSON object with name, country_code (ISO-2), language_code, cities (array), queries (5-10 synonyms in the country language), offer (draft). Do not wrap in markdown. Infer locations from the description, keep the offer factual."}'::jsonb WHERE key='ai.actions';
