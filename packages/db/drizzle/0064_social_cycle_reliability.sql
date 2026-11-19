INSERT INTO settings(key,value) VALUES
('social.inbox.failure_backoff_base_seconds','300'),
('social.inbox.failure_backoff_max_seconds','3600'),
('social.inbox.linkedin.enabled','false'),
('social.profile.busy_retry_seconds','5'),
('social.session.check.retry_seconds','900'),
('social.session.check.timeout_limit','3')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS message_send_by_message_latest
ON tasks ((payload->>'messageId'), created_at DESC, id DESC)
WHERE type='message.send';
