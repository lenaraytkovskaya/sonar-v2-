INSERT INTO settings(key,value) VALUES
 ('retention.registry_days','365'),
 ('tasks.registry.match','{"retryLimit":2,"retryDelay":60,"expireInSeconds":300}')
ON CONFLICT (key) DO NOTHING;
