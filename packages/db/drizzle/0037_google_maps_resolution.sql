-- https://developers.google.com/maps/ai/maps-experience-agent-tools/resolution-api
-- ResolveMapsUrls is billed at $0 under Text Search Essentials (IDs Only).
INSERT INTO settings(key,value) VALUES
 ('google.resolve.timeout_ms','10000'),
 ('google.resolve.max_bytes','65536'),
 ('google.resolve.price_usd','0')
ON CONFLICT(key) DO NOTHING;
