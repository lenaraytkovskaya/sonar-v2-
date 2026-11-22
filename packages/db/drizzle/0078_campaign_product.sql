ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS product_id uuid CONSTRAINT campaigns_product_id_products_id_fk REFERENCES products(id);
--> statement-breakpoint
-- Keep legacy columns untouched. Row locking and the link predicate make reruns atomic and idempotent.
DO $$
DECLARE c record; new_product_id uuid; description text; benefits text; overflow boolean; product_name text;
BEGIN
  FOR c IN SELECT id,name,offer,outreach_goal,created_by FROM campaigns
    WHERE product_id IS NULL AND (offer ~ '[^[:space:]]' OR outreach_goal ~ '[^[:space:]]') FOR UPDATE LOOP
    IF char_length(c.offer)+regexp_count(c.offer,U&'[\+010000-\+10FFFF]')>20000
       OR char_length(c.outreach_goal)+regexp_count(c.outreach_goal,U&'[\+010000-\+10FFFF]')>20000 THEN
      RAISE EXCEPTION 'Legacy product text exceeds 20000 characters for campaign %',c.id;
    END IF;
    description := c.offer || CASE WHEN c.outreach_goal<>'' THEN
      CASE WHEN c.offer<>'' THEN E'\n\n' ELSE '' END || 'Мета: ' || c.outreach_goal ELSE '' END;
    overflow := char_length(description)+regexp_count(description,U&'[\+010000-\+10FFFF]')>20000;
    benefits := '';
    IF overflow THEN description := c.offer; benefits := c.outreach_goal; END IF;
    product_name := left('Пропозиція: ' || c.name,120);
    WHILE char_length(product_name)+regexp_count(product_name,U&'[\+010000-\+10FFFF]')>120 LOOP
      product_name := left(product_name,char_length(product_name)-1);
    END LOOP;
    INSERT INTO products(name,description,benefits,status,created_by)
      VALUES(product_name,description,benefits,'active',c.created_by) RETURNING id INTO new_product_id;
    UPDATE campaigns SET product_id=new_product_id WHERE id=c.id;
    INSERT INTO activity_log(user_id,action,entity_type,entity_id,details)
      VALUES(c.created_by,'product.migrated','product',new_product_id::text,jsonb_build_object(
        'source','legacy_campaign','campaignId',c.id,'campaignName',c.name,'overflowToBenefits',overflow));
  END LOOP;
END $$;
