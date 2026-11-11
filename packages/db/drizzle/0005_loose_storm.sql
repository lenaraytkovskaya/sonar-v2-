CREATE TYPE "public"."batch_status" AS ENUM('queued', 'running', 'done', 'paused', 'failed');--> statement-breakpoint
CREATE TYPE "public"."company_status" AS ENUM('new', 'enriching', 'ready', 'contacted', 'replied', 'interested', 'deal', 'refused', 'do_not_contact');--> statement-breakpoint
CREATE TYPE "public"."contact_kind" AS ENUM('email', 'phone', 'telegram', 'whatsapp', 'viber', 'form', 'social', 'website');--> statement-breakpoint
CREATE TYPE "public"."contact_source" AS ENUM('google', 'website', 'registry', 'prozorro', 'manual');--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"size" integer NOT NULL,
	"status" "batch_status" DEFAULT 'queued' NOT NULL,
	"found_new" integer DEFAULT 0 NOT NULL,
	"found_known" integer DEFAULT 0 NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(20, 10) DEFAULT '0' NOT NULL,
	"reason_uk" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cursor" jsonb DEFAULT '{"pair":0,"page":0}'::jsonb NOT NULL,
	"config" jsonb NOT NULL,
	"request_key" uuid NOT NULL,
	"fixture" boolean DEFAULT false NOT NULL,
	CONSTRAINT "batches_request_key_unique" UNIQUE("request_key"),
	CONSTRAINT "batch_number_unique" UNIQUE("campaign_id","number")
);
--> statement-breakpoint
CREATE TABLE "campaign_companies" (
	"campaign_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_company_unique" UNIQUE("campaign_id","company_id")
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"place_id" text NOT NULL,
	"name" text NOT NULL,
	"primary_type" text,
	"types" text[] DEFAULT '{}' NOT NULL,
	"address" text,
	"city" text,
	"country_code" text,
	"lat" numeric(12, 8),
	"lng" numeric(12, 8),
	"website" text,
	"domain" text,
	"google_maps_uri" text,
	"rating" numeric(3, 2),
	"ratings_count" integer,
	"business_status" text,
	"status" "company_status" DEFAULT 'new' NOT NULL,
	"google_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_place_id_unique" UNIQUE("place_id")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" "contact_kind" NOT NULL,
	"value" text NOT NULL,
	"normalized" text NOT NULL,
	"source" "contact_source" NOT NULL,
	"source_url" text,
	"verified" boolean DEFAULT false NOT NULL,
	"rank" integer DEFAULT 0 NOT NULL,
	"found_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_unique" UNIQUE("company_id","kind","normalized")
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "field_profile" text DEFAULT 'contacts' NOT NULL;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_companies" ADD CONSTRAINT "campaign_companies_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_companies" ADD CONSTRAINT "campaign_companies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_companies" ADD CONSTRAINT "campaign_companies_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT INTO settings(key,value) VALUES ('google.field_profiles','[{"id": "contacts", "name": "Контакти", "fields": ["places.id", "places.displayName", "places.formattedAddress", "places.addressComponents", "places.location", "places.types", "places.primaryType", "places.businessStatus", "places.googleMapsUri", "nextPageToken", "places.websiteUri", "places.nationalPhoneNumber", "places.internationalPhoneNumber", "places.rating", "places.userRatingCount"], "priceUsd": 0.035, "sku": "Text Search Enterprise"}, {"id": "basic", "name": "Базовий (без сайта й телефону)", "fields": ["places.id", "places.displayName", "places.formattedAddress", "places.addressComponents", "places.location", "places.types", "places.primaryType", "places.businessStatus", "places.googleMapsUri", "nextPageToken"], "priceUsd": 0.032, "sku": "Text Search Pro"}]'),('retention.google_days','365') ON CONFLICT DO NOTHING;

--> statement-breakpoint
CREATE INDEX tasks_batch_idx ON tasks(batch_id);
CREATE INDEX campaign_companies_company_idx ON campaign_companies(company_id);

--> statement-breakpoint
UPDATE campaign_presets SET data=data||'{"field_profile":"contacts"}'::jsonb;
