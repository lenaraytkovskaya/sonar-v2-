INSERT INTO settings(key,value) VALUES
 ('prozorro.company.months','12'),
 ('prozorro.company.max_tenders','5'),
 ('prozorro.company.max_search_pages','10'),
 ('prozorro.full_sync.enabled','false'),
 ('tasks.prozorro.company','{"retryLimit":0,"retryDelay":60,"expireInSeconds":900}')
ON CONFLICT(key) DO NOTHING;
