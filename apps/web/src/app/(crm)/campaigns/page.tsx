import { CampaignPanel } from '@/components/campaign-panel';
export default async function Page() {
  const { sonarPool } = await import('@sonar/db');
  const {
    rows: [setting],
  } = await sonarPool.query(
    "select value from settings where key='scoring.default_weights'",
  );
  return <CampaignPanel defaultWeights={setting.value} />;
}
