CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"tagline" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"audience" text DEFAULT '' NOT NULL,
	"benefits" text DEFAULT '' NOT NULL,
	"terms" text DEFAULT '' NOT NULL,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"videos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_name_length" CHECK (char_length(trim("products"."name")) between 1 and 120),
	CONSTRAINT "products_description_length" CHECK (char_length("products"."description") <= 20000),
	CONSTRAINT "products_status" CHECK ("products"."status" in ('active','archived')),
	CONSTRAINT "products_links_limit" CHECK (jsonb_typeof("products"."links") = 'array' and jsonb_array_length("products"."links") <= 20),
	CONSTRAINT "products_photos_limit" CHECK (jsonb_typeof("products"."photos") = 'array' and jsonb_array_length("products"."photos") <= 30),
	CONSTRAINT "products_videos_limit" CHECK (jsonb_typeof("products"."videos") = 'array' and jsonb_array_length("products"."videos") <= 10)
);

--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
