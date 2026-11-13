INSERT INTO settings(key,value) VALUES ('social.account_proxy_index','0')
ON CONFLICT(key) DO NOTHING;
