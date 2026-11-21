-- Frequent page loads of encrypted chats looked like automation and were followed by slow loads.
UPDATE settings SET value='120'::jsonb WHERE key='social.inbox.listen_sweep_seconds' AND value='20'::jsonb;
