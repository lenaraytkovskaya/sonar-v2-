INSERT INTO settings(key,value) VALUES('campaign.defaults',
  '{"country_code":"UA","language_code":"uk","language_codes":["uk"],"cities":[],"queries":[],"batch_size":20,"budget_usd":0,"channels":{"email":true,"telegram":false,"whatsapp":false,"viber":false,"forms":false},"send_mode":"manual","min_score":40}'::jsonb)
ON CONFLICT (key) DO NOTHING;
