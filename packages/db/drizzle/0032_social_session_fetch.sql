ALTER TYPE contact_kind ADD VALUE IF NOT EXISTS 'address';
--> statement-breakpoint
INSERT INTO settings(key,value) VALUES
('social.instagram.session_fetch_gap_seconds','90'),
('social.facebook.session_fetch_gap_seconds','90'),
('social.linkedin.session_fetch_gap_seconds','90'),
('social.instagram.session_fetch_daily_limit','60'),
('social.facebook.session_fetch_daily_limit','60'),
('social.linkedin.session_fetch_daily_limit','60')
ON CONFLICT(key) DO NOTHING;
