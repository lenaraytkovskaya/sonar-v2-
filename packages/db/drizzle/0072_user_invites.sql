CREATE TABLE IF NOT EXISTS user_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  token text NOT NULL UNIQUE,
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  sent_at timestamptz,
  accepted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS user_invites_open_email
  ON user_invites (lower(email)) WHERE accepted_at IS NULL;
INSERT INTO settings(key,value) VALUES
  ('auth.password_min_length','8'::jsonb),
  ('auth.invite_ttl_hours','72'::jsonb)
ON CONFLICT (key) DO NOTHING;
