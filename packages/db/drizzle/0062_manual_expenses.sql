CREATE TABLE manual_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  category text NOT NULL,
  amount numeric(20,10) NOT NULL CHECK (amount > 0),
  currency text NOT NULL CHECK (currency IN ('USD','UAH','EUR')),
  amount_usd numeric(20,10) NOT NULL CHECK (amount_usd > 0),
  rate_used numeric(20,10) NOT NULL CHECK (rate_used > 0),
  paid_on date NOT NULL,
  paid_until date,
  account_id uuid REFERENCES channel_accounts(id) ON DELETE SET NULL,
  note text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  renewed_from_id uuid REFERENCES manual_expenses(id) ON DELETE SET NULL,
  CONSTRAINT manual_expense_category_valid CHECK (category IN ('proxy','phone','subscription','other'))
);--> statement-breakpoint
CREATE INDEX manual_expenses_paid_on_idx ON manual_expenses(paid_on);--> statement-breakpoint
CREATE UNIQUE INDEX manual_expenses_renewal_once ON manual_expenses(renewed_from_id) WHERE renewed_from_id IS NOT NULL;--> statement-breakpoint
INSERT INTO settings(key,value) VALUES
  ('finance.rates','{"USD":1,"UAH":0.024,"EUR":1.08}'::jsonb),
  ('finance.renewal_reminder_days','3'::jsonb)
ON CONFLICT(key) DO NOTHING;
