CREATE TABLE "prozorro_parties" (
	"code" text NOT NULL,
	"scheme" text,
	"name" text,
	"contact_name" text,
	"email" text,
	"telephone" text,
	"url" text,
	"role" text NOT NULL,
	"doc_type" text NOT NULL,
	"doc_id" text NOT NULL,
	"public_id" text,
	"source_url" text NOT NULL,
	"title" text,
	"amount" numeric,
	"currency" text,
	"date" timestamp with time zone NOT NULL,
	CONSTRAINT "prozorro_parties_doc_type_doc_id_code_role_pk" PRIMARY KEY("doc_type","doc_id","code","role"),
	CONSTRAINT "prozorro_role" CHECK ("prozorro_parties"."role" in ('supplier','tenderer','buyer')),
	CONSTRAINT "prozorro_doc_type" CHECK ("prozorro_parties"."doc_type" in ('tender','contract'))
);
--> statement-breakpoint
CREATE INDEX "prozorro_parties_code_idx" ON "prozorro_parties" USING btree ("code");--> statement-breakpoint
CREATE INDEX "prozorro_parties_phone_idx" ON "prozorro_parties" USING btree ("telephone");--> statement-breakpoint
CREATE INDEX "prozorro_parties_email_idx" ON "prozorro_parties" USING btree ("email");--> statement-breakpoint
INSERT INTO settings(key,value) VALUES
 ('prozorro.enabled','true'),
 ('prozorro.rate_per_second','5'),
 ('prozorro.page_size','100'),
 ('prozorro.timeout_ms','30000'),
 ('prozorro.max_retries','4'),
 ('prozorro.retry_delay_ms','1000'),
 ('prozorro.min_free_bytes','5368709120'),
 ('prozorro.min_free_ratio','0.1'),
 ('prozorro.disk_path','"/host-disk"'),
 ('tasks.prozorro.sync','{"retryLimit":2,"retryDelay":60,"expireInSeconds":600}'),
 ('tasks.prozorro.lookup','{"retryLimit":2,"retryDelay":60,"expireInSeconds":300}'),
 ('prozorro.tender.progress','{"offset":"","documents":0,"rows":0,"cursorDate":null,"status":"queued","reasonUk":null}'),
 ('prozorro.contract.progress','{"offset":"","documents":0,"rows":0,"cursorDate":null,"status":"queued","reasonUk":null}')
ON CONFLICT (key) DO NOTHING;
