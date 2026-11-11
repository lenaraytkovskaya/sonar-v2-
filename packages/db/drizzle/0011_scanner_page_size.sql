-- Real homepages with inline assets exceed 2 MB; keep any value an operator already changed.
UPDATE settings SET value='5000000', updated_at=now() WHERE key='scanner.max_bytes' AND value='2000000'::jsonb;
