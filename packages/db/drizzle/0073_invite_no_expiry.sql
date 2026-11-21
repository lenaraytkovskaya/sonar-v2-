ALTER TABLE user_invites ALTER COLUMN expires_at DROP NOT NULL;
UPDATE user_invites SET expires_at = NULL WHERE accepted_at IS NULL;
INSERT INTO settings(key,value) VALUES ('auth.invite_ttl_hours','0'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = '0'::jsonb;
