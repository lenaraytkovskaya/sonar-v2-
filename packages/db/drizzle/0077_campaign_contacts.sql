UPDATE campaigns SET field_profile='contacts' WHERE field_profile<>'contacts';
--> statement-breakpoint
-- Append required contact fields without replacing the administrator's tariff, SKU or existing fields.
UPDATE settings SET value=(
  SELECT jsonb_agg(CASE WHEN profile->>'id'='contacts' THEN
    jsonb_set(profile,'{fields}',(
      SELECT jsonb_agg(field ORDER BY first_seen) FROM (
        SELECT field,min(n) AS first_seen FROM jsonb_array_elements((profile->'fields') || '["places.id", "places.displayName", "places.formattedAddress", "places.addressComponents", "places.location", "places.types", "places.primaryType", "places.primaryTypeDisplayName", "places.businessStatus", "places.googleMapsUri", "nextPageToken", "places.websiteUri", "places.nationalPhoneNumber", "places.internationalPhoneNumber", "places.rating", "places.userRatingCount", "places.regularOpeningHours"]'::jsonb)
        WITH ORDINALITY fields(field,n) GROUP BY field
      ) deduplicated
    )) ELSE profile END ORDER BY ordinal)
  FROM jsonb_array_elements(value) WITH ORDINALITY profiles(profile,ordinal)
),updated_at=now() WHERE key='google.field_profiles';
