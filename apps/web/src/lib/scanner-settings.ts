// Bounds protect worker resources; configured values always come from the database.
export const scannerFields = {
  'scanner.max_pages': { min: 1, max: 100, integer: true },
  'scanner.timeout_ms': { min: 100, max: 120000, integer: true },
  'scanner.max_bytes': { min: 1000, max: 20000000, integer: true },
  'scanner.ai_max_usd': { min: 0, max: 1, integer: false },
  'scanner.ai_max_tokens': { min: 1, max: 10000, integer: true },
  'retention.website_days': { min: 1, max: 3650, integer: true },
} as const;
export type ScannerSettings = Record<string, string | number | boolean>;
export const scannerKeys = [
  ...Object.keys(scannerFields),
  'scanner.user_agent',
  'scanner.ai_fallback',
  'scanner.ai_prompt',
];
export function validScannerSettings(value: unknown): value is ScannerSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as ScannerSettings;
  return (
    Object.keys(data).every((key) => scannerKeys.includes(key)) &&
    Object.entries(scannerFields).every(
      ([key, range]) =>
        typeof data[key] === 'number' &&
        Number.isFinite(data[key]) &&
        Number(data[key]) >= range.min &&
        Number(data[key]) <= range.max &&
        (!range.integer || Number.isInteger(data[key])),
    ) &&
    typeof data['scanner.ai_fallback'] === 'boolean' &&
    ['scanner.user_agent', 'scanner.ai_prompt'].every(
      (key) =>
        typeof data[key] === 'string' &&
        String(data[key]).trim().length > 0 &&
        String(data[key]).length <=
          (key === 'scanner.user_agent' ? 500 : 20000) &&
        (key !== 'scanner.user_agent' || !/[\r\n]/.test(String(data[key]))),
    )
  );
}
