ALTER TABLE campaigns ADD COLUMN language_codes text[] NOT NULL DEFAULT ARRAY['uk'];
UPDATE campaigns SET language_codes=ARRAY[language_code]
WHERE language_codes=ARRAY['uk'] AND language_code<>'uk';
--> statement-breakpoint
-- Preserve every original key and token, even for queries/cities removed since payment.
DO $$
DECLARE c record; item record; parts jsonb; target text; additions jsonb; origin text;
BEGIN
  FOR c IN SELECT id,language_code,google_progress FROM campaigns LOOP
    additions := '{}'::jsonb;
    FOR item IN SELECT key,value FROM jsonb_each(c.google_progress) LOOP
      BEGIN
        parts := item.key::jsonb;
      EXCEPTION WHEN invalid_text_representation THEN CONTINUE;
      END;
      IF jsonb_typeof(parts)<>'array' THEN CONTINUE; END IF;
      IF jsonb_array_length(parts)=2
         AND jsonb_typeof(parts->0)='string' AND jsonb_typeof(parts->1)='string' THEN
        -- The campaign's current language may have changed after this cursor was paid.
        SELECT b.config->>'language_code' INTO origin
        FROM batches b JOIN tasks t ON t.batch_id=b.id LEFT JOIN spend_events s ON s.task_id=t.id
        CROSS JOIN LATERAL jsonb_array_elements_text(b.config->'queries') WITH ORDINALITY q(value,n)
        CROSS JOIN LATERAL jsonb_array_elements_text(b.config->'cities') WITH ORDINALITY city(value,n)
        WHERE b.campaign_id=c.id AND NOT b.config ? 'language_codes'
          AND q.value=parts->>0 AND city.value=parts->>1
          AND t.type='google.request' AND t.status='done' AND (b.fixture OR s.meta ? 'response')
          AND t.idempotency_key LIKE 'google.request:' || b.id::text || ':' || ((q.n-1)*jsonb_array_length(b.config->'cities')+city.n-1)::text || ':%'
        ORDER BY t.created_at DESC,s.created_at DESC LIMIT 1;
        IF origin IS NULL THEN
          IF coalesce((item.value->>'pages')::int,0)>0 OR item.value ? 'token' OR jsonb_array_length(coalesce(item.value->'buffer','[]'::jsonb))>0 THEN
            RAISE EXCEPTION 'Cannot safely determine original Google cursor language for campaign % key %',c.id,item.key;
          END IF;
          origin := c.language_code;
        END IF;
        target := '[' || (parts->0)::text || ',' || (parts->1)::text || ',' || to_jsonb(origin)::text || ']';
        IF NOT c.google_progress ? target THEN additions := additions || jsonb_build_object(target,item.value); END IF;
      END IF;
    END LOOP;
    UPDATE campaigns SET google_progress=google_progress || additions WHERE id=c.id;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION sync_campaign_languages() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.language_code IS DISTINCT FROM OLD.language_code AND NEW.language_codes IS NOT DISTINCT FROM OLD.language_codes THEN
      NEW.language_codes := ARRAY[NEW.language_code];
    END IF;
  ELSIF NEW.language_codes=ARRAY['uk'] AND NEW.language_code<>'uk' THEN
    NEW.language_codes := ARRAY[NEW.language_code];
  END IF;
  IF coalesce(cardinality(NEW.language_codes),0)=0 THEN RAISE EXCEPTION 'Campaign languages cannot be empty'; END IF;
  NEW.language_code := NEW.language_codes[1];
  RETURN NEW;
END $$;
CREATE TRIGGER campaigns_sync_languages BEFORE INSERT OR UPDATE OF language_code,language_codes ON campaigns
FOR EACH ROW EXECUTE FUNCTION sync_campaign_languages();
