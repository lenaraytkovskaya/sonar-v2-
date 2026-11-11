CREATE TABLE "company_scores" (
	"company_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"score" numeric NOT NULL,
	"breakdown" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_score_unique" UNIQUE("company_id","campaign_id"),
	CONSTRAINT "company_score_range" CHECK ("company_scores"."score" >= 0 and "company_scores"."score" <= 100)
);
--> statement-breakpoint
ALTER TABLE "company_scores" ADD CONSTRAINT "company_scores_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_scores" ADD CONSTRAINT "company_scores_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO settings(key,value) VALUES
 ('scoring.default_weights','{"website":15,"phone":15,"email":20,"messenger":15,"form":5,"rating":10,"registry":10,"reachability":10}'),
 ('tasks.company.score','{"retryLimit":2,"retryDelay":10,"expireInSeconds":300}')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
UPDATE campaign_presets SET data=jsonb_set(data,'{scoring_weights}',
 (SELECT value FROM settings WHERE key='scoring.default_weights') || coalesce(data->'scoring_weights','{}'));
UPDATE campaigns SET scoring_weights=(SELECT value FROM settings WHERE key='scoring.default_weights') || scoring_weights;
--> statement-breakpoint
UPDATE settings SET value=jsonb_set(value,'{company_filters}',to_jsonb((value->>'company_filters') || ' Also supported: minScore (number 0 to 100), sort (score or newest).')) WHERE key='ai.actions';

--> statement-breakpoint
ALTER TABLE campaigns ADD COLUMN scoring_revision integer NOT NULL DEFAULT 0;
