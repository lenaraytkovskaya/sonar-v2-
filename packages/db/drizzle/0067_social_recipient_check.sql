INSERT INTO settings(key,value) VALUES
('tasks.social.recipient.check','{"retryLimit":0,"retryDelay":30,"expireInSeconds":600}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE UNIQUE INDEX social_recipient_check_one_contact
ON tasks((payload->>'contactId'))
WHERE type='social.recipient.check' AND status IN ('queued','running');
