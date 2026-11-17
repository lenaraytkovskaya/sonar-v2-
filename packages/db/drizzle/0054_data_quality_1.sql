ALTER TYPE contact_kind ADD VALUE IF NOT EXISTS 'booking';
--> statement-breakpoint
INSERT INTO settings(key, value)
VALUES ('social.enabled', 'true')
ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now();
