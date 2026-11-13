ALTER TYPE contact_source ADD VALUE IF NOT EXISTS 'facebook';
--> statement-breakpoint
ALTER TYPE contact_source ADD VALUE IF NOT EXISTS 'instagram';
--> statement-breakpoint
ALTER TYPE contact_source ADD VALUE IF NOT EXISTS 'linkedin';
--> statement-breakpoint
ALTER TABLE company_facts DROP CONSTRAINT company_fact_source;
ALTER TABLE company_facts ADD CONSTRAINT company_fact_source CHECK (source in ('google','website','registry','prozorro','manual','ai','facebook','instagram','linkedin'));
--> statement-breakpoint
INSERT INTO settings(key,value) VALUES
('social.enabled','false'),
('social.cost_per_request_usd','0.001'),
('social.page_timeout_ms','30000'),
('social.facebook.min_gap_seconds','60'),
('social.facebook.daily_limit','100'),
('social.facebook.pause_minutes','60'),
('social.facebook.runtime','{}'),
('social.instagram.min_gap_seconds','90'),
('social.instagram.daily_limit','100'),
('social.instagram.pause_minutes','60'),
('social.instagram.runtime','{}'),
('social.linkedin.min_gap_seconds','120'),
('social.linkedin.daily_limit','50'),
('social.linkedin.pause_minutes','120'),
('social.linkedin.runtime','{}'),
('tasks.social.fetch','{"retryLimit":0,"retryDelay":30,"expireInSeconds":300}')
ON CONFLICT(key) DO NOTHING;
