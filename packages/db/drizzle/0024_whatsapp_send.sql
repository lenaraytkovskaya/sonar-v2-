CREATE UNIQUE INDEX "channel_accounts_whatsapp_singleton" ON "channel_accounts" ("channel") WHERE "channel" = 'whatsapp';
--> statement-breakpoint
INSERT INTO "settings" ("key", "value") VALUES
('send.whatsapp.min_gap_seconds', '90'),
('send.whatsapp.max_gap_seconds', '300')
ON CONFLICT ("key") DO NOTHING;
