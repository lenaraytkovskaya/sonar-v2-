CREATE TABLE "contact_suppressions" (
	"company_id" uuid NOT NULL,
	"kind" "contact_kind" NOT NULL,
	"normalized" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_suppressions_pk" PRIMARY KEY("company_id","kind","normalized")
);
--> statement-breakpoint
ALTER TABLE "contact_suppressions" ADD CONSTRAINT "contact_suppressions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- A person removed or corrected this contact: a rescan must not bring the old value back.
CREATE FUNCTION skip_suppressed_contact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM contact_suppressions s
    WHERE s.company_id = NEW.company_id AND s.kind = NEW.kind AND s.normalized = NEW.normalized
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER contacts_skip_suppressed BEFORE INSERT ON contacts
FOR EACH ROW EXECUTE FUNCTION skip_suppressed_contact();
