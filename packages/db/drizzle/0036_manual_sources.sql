-- Place Details Enterprise: configured per-request tariff, independent of Text Search.
INSERT INTO settings(key,value) VALUES
 ('google.details.price_usd','0.02'),
 ('tasks.google.company','{"retryLimit":0,"retryDelay":60,"expireInSeconds":300}')
ON CONFLICT(key) DO NOTHING;
