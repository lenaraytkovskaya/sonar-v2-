INSERT INTO settings(key,value) VALUES('campaign.progress_poll_ms','7500'::jsonb) ON CONFLICT (key) DO NOTHING;
