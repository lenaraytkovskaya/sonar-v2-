import type { PoolClient } from 'pg';
import { productOfferText } from '@sonar/core';
import { sonarPool } from './index.js';

export async function campaignOfferContext(
  campaignId: string,
  client: Pick<PoolClient, 'query'> = sonarPool,
) {
  // Never select terms, media, or serialize an entire product into client AI context.
  const {
    rows: [row],
  } = await client.query(
    `select c.product_id,c.offer,c.outreach_goal,p.name,p.tagline,p.description,p.audience,p.benefits,p.links
     from campaigns c left join products p on p.id=c.product_id where c.id=$1`,
    [campaignId],
  );
  return row?.product_id
    ? {
        productId: String(row.product_id),
        offer: productOfferText(row),
        outreachGoal: '',
      }
    : {
        productId: null,
        offer: String(row?.offer ?? ''),
        outreachGoal: String(row?.outreach_goal ?? ''),
      };
}
