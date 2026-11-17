export const socialNetworks = ['facebook', 'instagram', 'linkedin'] as const;
export const socialFields = {
  'social.login.daily_limit': { min: 1, max: 100, step: 1 },
  'social.login.relogin_cooldown_hours': { min: 1, max: 8760, step: 1 },
  'social.cost_per_request_usd': { min: 0, max: 100, step: 0.001 },
  'social.page_timeout_ms': { min: 100, max: 120000, step: 1 },
  'social.inbox.poll_seconds': { min: 30, max: 86400, step: 1 },
  'social.inbox.daily_limit': { min: 1, max: 100000, step: 1 },
  'social.inbox.max_threads': { min: 1, max: 10000, step: 1 },
  'social.inbox.max_messages': { min: 1, max: 10000, step: 1 },
  ...Object.fromEntries(
    socialNetworks.flatMap((network) => [
      [`social.${network}.daily_limit`, { min: 1, max: 100000, step: 1 }],
      [`social.${network}.min_gap_seconds`, { min: 0, max: 86400, step: 1 }],
      [`social.${network}.pause_minutes`, { min: 0, max: 10080, step: 1 }],
      [
        `social.${network}.session_fetch_gap_seconds`,
        { min: 0, max: 86400, step: 1 },
      ],
      [
        `social.${network}.session_fetch_daily_limit`,
        { min: 1, max: 100000, step: 1 },
      ],
    ]),
  ),
} as Record<string, { min: number; max: number; step: number }>;
export const socialKeys = [
  'social.enabled',
  'social.inbox.enabled',
  'social.inbox.facebook.enabled',
  'social.inbox.instagram.enabled',
  ...Object.keys(socialFields),
];
export type SocialSettings = Record<string, number | boolean>;
export function validSocialSettings(value: unknown): value is SocialSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as SocialSettings;
  return (
    typeof data['social.enabled'] === 'boolean' &&
    [
      'social.inbox.enabled',
      'social.inbox.facebook.enabled',
      'social.inbox.instagram.enabled',
    ].every((key) => typeof data[key] === 'boolean') &&
    Object.keys(data).every((key) => socialKeys.includes(key)) &&
    Object.entries(socialFields).every(
      ([key, range]) =>
        typeof data[key] === 'number' &&
        Number.isFinite(data[key]) &&
        Number(data[key]) >= range.min &&
        Number(data[key]) <= range.max &&
        (range.step !== 1 || Number.isInteger(data[key])),
    )
  );
}
