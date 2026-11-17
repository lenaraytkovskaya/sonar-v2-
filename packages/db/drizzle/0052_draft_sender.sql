-- Keep sender identification and placeholder rules in the configurable draft prompts.
UPDATE settings SET value=to_jsonb(value #>> '{}' || E'\n' || $prompt$Use sender.name as the sender name when introducing the sender. If sender.name is blank, omit the name and introduction rather than inventing one. Never output square-bracket or curly-brace placeholders such as [name], [ім’я] or {company}; use supplied facts or omit the missing detail.$prompt$::text),updated_at=now()
WHERE key='draft.prompt';
--> statement-breakpoint
UPDATE settings SET value=jsonb_set(value,'{reply}',to_jsonb((value->>'reply') || E'\n' || $prompt$Use sender.name as the sender name when introducing the sender. If sender.name is blank, omit the name and introduction rather than inventing one. Never output square-bracket or curly-brace placeholders such as [name], [ім’я] or {company}; use supplied facts or omit the missing detail.$prompt$::text)),updated_at=now()
WHERE key='ai.actions' AND jsonb_typeof(value->'reply')='string';
