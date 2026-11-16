INSERT INTO settings(key,value) VALUES
('social.keepalive.enabled','true'),
('social.keepalive.interval_seconds','21600'),
('social.keepalive.jitter_seconds','1800'),
('social.keepalive.daily_limit','6'),
('social.keepalive.pause_ms','1500'),
('social.keepalive.retry_seconds','900'),
('social.action.daily_limit','200')
ON CONFLICT(key) DO NOTHING;
--> statement-breakpoint
-- Credentials are unavailable to SQL; runtime resolves the new list pin once under the account lock.
UPDATE channel_accounts SET status=CASE WHEN status='disabled' THEN status ELSE 'paused' END,
settings=(settings-'proxyFingerprint')||'{"proxyIndex":1,"proxyFingerprintPending":true,"sessionStatus":"pending","reasonUk":"Проксі змінено. Можлива перевірка входу."}'::jsonb
WHERE channel='linkedin' AND settings->>'proxyIndex'='0' AND settings->>'ownProxyEncrypted' IS NULL;
