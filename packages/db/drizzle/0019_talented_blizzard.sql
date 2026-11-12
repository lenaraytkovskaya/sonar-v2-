CREATE TABLE "registry_phones" (
	"phone_e164" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" bigint NOT NULL,
	"confidence" numeric NOT NULL,
	CONSTRAINT "registry_phones_phone_e164_entity_type_entity_id_pk" PRIMARY KEY("phone_e164","entity_type","entity_id")
);
--> statement-breakpoint
CREATE INDEX "registry_phones_phone_idx" ON "registry_phones" USING btree ("phone_e164");
--> statement-breakpoint
INSERT INTO settings(key,value) VALUES
 ('registry.phones.batch_size','50000'),
 ('registry.phones.statement_timeout_ms','30000'),
 ('registry.phones.progress','{"cursor":"0","scanned":0,"indexed":0,"estimatedTotal":null,"status":"done","updatedAt":null}'),
 ('tasks.registry.phones.sync','{"retryLimit":2,"retryDelay":60,"expireInSeconds":86400}')
ON CONFLICT (key) DO NOTHING;
