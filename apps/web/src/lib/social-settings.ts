export const socialNetworks = ['facebook', 'instagram', 'linkedin'] as const;
export const socialFields = {
  'social.cost_per_request_usd': { min: 0, max: 100, step: 0.001 },
  'social.page_timeout_ms': { min: 100, max: 120000, step: 1 },
  ...Object.fromEntries(
    socialNetworks.flatMap((network) => [
      [`social.${network}.daily_limit`, { min: 1, max: 100000, step: 1 }],
      [`social.${network}.min_gap_seconds`, { min: 0, max: 86400, step: 1 }],
      [`social.${network}.pause_minutes`, { min: 0, max: 10080, step: 1 }],
    ]),
  ),
} as Record<string, { min: number; max: number; step: number }>;
export const socialKeys = ['social.enabled', ...Object.keys(socialFields)];
export type SocialSettings = Record<string, number | boolean>;
export function validSocialSettings(value: unknown): value is SocialSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as SocialSettings;
  return (
    typeof data['social.enabled'] === 'boolean' &&
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
