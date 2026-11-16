ALTER TABLE spend_events DROP CONSTRAINT spend_events_task_id_unique;
--> statement-breakpoint
ALTER TABLE spend_events ADD COLUMN attempt smallint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE spend_events ADD CONSTRAINT spend_events_attempt_nonnegative CHECK (attempt >= 0);
--> statement-breakpoint
ALTER TABLE spend_events ADD CONSTRAINT spend_events_task_attempt_unique UNIQUE(task_id,attempt);
--> statement-breakpoint
INSERT INTO settings(key,value) VALUES ('ai.reasoning','{"effort":"low","exclude":true}') ON CONFLICT(key) DO NOTHING;
