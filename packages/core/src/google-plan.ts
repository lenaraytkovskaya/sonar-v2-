import { normalizeCampaignLanguages } from './campaign.js';
import type { GooglePage } from './google.js';
export type GooglePlanConfig = {
  queries: string[];
  cities: string[];
  language_code?: string;
  language_codes?: string[];
};
export type GoogleProgress = Record<
  string,
  {
    pages: number;
    token?: string;
    exhausted: boolean;
    buffer: GooglePage['places'];
    reason?: string;
  }
>;
export const googlePairKey = (query: string, city: string, language: string) =>
  JSON.stringify([query, city, language]);
// Language is innermost so legacy one-language batch indices and paid task keys stay stable.
export function googleSearchPairs(config: GooglePlanConfig) {
  return config.queries.flatMap((query) =>
    config.cities.flatMap((city) =>
      normalizeCampaignLanguages(config).language_codes.map((language) => ({
        query,
        city,
        language,
      })),
    ),
  );
}
export function plannedGoogleRequests(
  config: GooglePlanConfig,
  progress: GoogleProgress,
) {
  return googleSearchPairs(config).reduce((total, pair) => {
    const state = progress[googlePairKey(pair.query, pair.city, pair.language)];
    return (
      total + (state?.exhausted ? 0 : Math.max(0, 3 - (state?.pages ?? 0)))
    );
  }, 0);
}
