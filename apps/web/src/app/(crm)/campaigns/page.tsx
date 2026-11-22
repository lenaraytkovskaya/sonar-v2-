import { CampaignPanel } from '@/components/campaign-panel';
import {
  campaignDefaultsSchema,
  campaignSchema,
  profilesSchema,
  campaignProgressPollSchema,
} from '@sonar/core';
export default async function Page() {
  const { sonarPool } = await import('@sonar/db');
  const { rows } = await sonarPool.query(
    "select key,value from settings where key in ('campaign.defaults','scoring.default_weights','google.field_profiles','campaign.progress_poll_ms')",
  );
  const config = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const profile = profilesSchema
    .parse(config['google.field_profiles'])
    .find((value) => value.id === 'contacts')!;
  return (
    <CampaignPanel
      defaults={campaignDefaultsSchema.parse(config['campaign.defaults'])}
      defaultWeights={campaignSchema.shape.scoring_weights.parse(
        config['scoring.default_weights'],
      )}
      pollMs={campaignProgressPollSchema.parse(
        config['campaign.progress_poll_ms'],
      )}
      googlePriceUsd={profile.priceUsd}
    />
  );
}
