-- Classified pages are isolated from the general website crawler; the domain map
-- also drives company grouping and presentation consistently.
INSERT INTO settings(key, value) VALUES ('platforms.kinds', '{"olx.ua":"classified","olx.pl":"classified","prom.ua":"classified","rozetka.com.ua":"classified","epicentrk.ua":"classified","auto.ria.com":"classified","ria.com":"classified","autoria.com":"classified","all.biz":"classified","uaprom.net":"classified","zakupivli.pro":"classified","master.shop":"classified","business.site":"minisite","taplink.cc":"minisite","taplink.ws":"minisite","linktr.ee":"minisite","sites.google.com":"minisite","facebook.com":"social","instagram.com":"social","t.me":"social","tiktok.com":"social","youtube.com":"social","google.com":"maps","goo.gl":"maps","maps.app.goo.gl":"maps","2gis.ua":"maps","yell.ua":"maps","bizkatalog.com.ua":"maps"}'::jsonb)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
UPDATE settings SET value = (SELECT jsonb_agg(domain ORDER BY domain) FROM jsonb_object_keys((SELECT value FROM settings WHERE key = 'platforms.kinds')) AS domain)
WHERE key = 'platforms.domains';
