import { expect, it } from 'vitest';
import { scannerKeys, validScannerSettings } from './scanner-settings';
const settings = {
  'scanner.max_pages': 12,
  'scanner.timeout_ms': 15000,
  'scanner.max_bytes': 2000000,
  'scanner.ai_max_usd': 0.002,
  'scanner.ai_max_tokens': 600,
  'retention.website_days': 365,
  'scanner.user_agent': 'SonarBot/1.0 (+https://sonar.cryid.com)',
  'scanner.ai_fallback': true,
  'scanner.ai_prompt': 'Extract explicit contacts only.',
};
it('accepts scanner settings and zero AI budget; rejects unbounded resources and header injection', () => {
  expect(validScannerSettings(settings)).toBe(true);
  expect(Object.keys(settings).sort()).toEqual(scannerKeys.sort());
  expect(validScannerSettings({ ...settings, 'scanner.ai_max_usd': 0 })).toBe(
    true,
  );
  for (const [key, values] of Object.entries({
    'scanner.max_pages': [0, 101, 1.5, '12'],
    'scanner.timeout_ms': [-1, Infinity, 120001],
    'scanner.max_bytes': [0, 20000001],
    'scanner.ai_max_usd': [-1, NaN, 2],
    'scanner.ai_max_tokens': [0, 10001],
    'retention.website_days': [0, 3651],
    'scanner.user_agent': ['', 'Bot\r\nX-Injected: yes'],
    'scanner.ai_fallback': [1, 'true'],
    'scanner.ai_prompt': ['', ' '.repeat(10)],
  }))
    for (const value of values)
      expect(validScannerSettings({ ...settings, [key]: value })).toBe(false);
  expect(validScannerSettings({ ...settings, 'unknown.key': 1 })).toBe(false);
  const { 'scanner.ai_prompt': missing, ...incomplete } = settings;
  expect(missing).toBeTruthy();
  expect(validScannerSettings(incomplete)).toBe(false);
  for (const invalid of [null, [], 12, 'text'])
    expect(validScannerSettings(invalid)).toBe(false);
});
