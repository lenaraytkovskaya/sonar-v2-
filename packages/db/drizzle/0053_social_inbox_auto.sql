INSERT INTO settings(key,value) VALUES
('social.inbox.enabled','true'),
('social.inbox.facebook.enabled','true'),
('social.inbox.instagram.enabled','true'),
('social.inbox.max_threads','50'),
('social.inbox.max_messages','100'),
('social.inbox.quiet_hours','"00:00-07:00"')
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now();
--> statement-breakpoint
UPDATE channel_accounts
SET settings=settings||jsonb_build_object('inboxPollingEnabled',true)
WHERE channel IN ('instagram','facebook')
  AND status='active'
  AND settings->>'sessionStatus'='valid'
  AND settings->>'inboxPollingEnabled' IS NULL;
