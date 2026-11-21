// Where each task type finds its campaign. A paused campaign stops every type listed here.
export type CampaignPauseScope = 'campaign' | 'message' | 'batch' | 'company';

export const campaignPauseScopes: Record<
  string,
  { scope: CampaignPauseScope; guard: boolean }
> = {
  // guard=false: the handler already pauses itself with its own reason and state.
  'google.batch': { scope: 'batch', guard: false },
  'message.send': { scope: 'message', guard: false },
  'ai.inbound': { scope: 'message', guard: true },
  'ai.drafts': { scope: 'campaign', guard: true },
  'company.score': { scope: 'campaign', guard: true },
  'company.analyze': { scope: 'campaign', guard: true },
  'site.scan': { scope: 'company', guard: true },
  'registry.match': { scope: 'company', guard: true },
  'prozorro.company': { scope: 'company', guard: true },
  'social.fetch': { scope: 'company', guard: true },
};

export const campaignPausedReasonCode = 'campaign_paused';
export const campaignPausedReasonUk =
  'Кампанію призупинено. Завдання продовжиться після відновлення.';
// message.send pauses itself with this code when the campaign is not active.
export const campaignInactiveReasonCode = 'campaign_inactive';

export const campaignPauseTypes = (scope: CampaignPauseScope) =>
  Object.entries(campaignPauseScopes)
    .filter(([, value]) => value.scope === scope)
    .map(([type]) => type);
