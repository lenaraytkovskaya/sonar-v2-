ALTER TABLE tasks ADD COLUMN updated_at timestamp with time zone NOT NULL DEFAULT now();--> statement-breakpoint
UPDATE tasks SET updated_at=coalesce(started_at,created_at);--> statement-breakpoint
CREATE FUNCTION touch_tasks_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER tasks_updated_at BEFORE UPDATE ON tasks
FOR EACH ROW EXECUTE FUNCTION touch_tasks_updated_at();--> statement-breakpoint

INSERT INTO settings(key,value) VALUES
('tasks.reconciler','{"staleBufferSeconds":60,"defaultExpireInSeconds":300}')
ON CONFLICT(key) DO NOTHING;
