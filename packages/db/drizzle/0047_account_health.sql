CREATE TABLE account_health_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('relogin_ok','relogin_failed','session_lost','code_requested','captcha','checkpoint','action_blocked','rate_limited','send_failed','auto_paused','auto_resumed')),
  reason_uk text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX account_health_events_account_created ON account_health_events(account_id,created_at DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX account_health_events_event_key ON account_health_events(account_id,kind,(details->>'eventKey'));
--> statement-breakpoint
INSERT INTO settings(key,value) VALUES
  ('health.pause_hours','24'),
  ('health.repeat_pause_hours','48'),
  ('health.repeat_window_days','7'),
  ('health.retention_days','90'),
  ('health.summary_days','14'),
  ('health.watch_send_failures','1'),
  ('health.watch_relogins','1'),
  ('health.warning_alarms','1')
ON CONFLICT(key) DO NOTHING;
