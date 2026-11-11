import { expect, it } from 'vitest';
import { modelRefreshError } from './model-refresh-error';
import { uk } from '../i18n/uk';

it('distinguishes refresh failures and preserves useful unrecognized errors', () => {
  const codes = [
    'api_key_missing',
    'http_401',
    'http_429',
    'network_unavailable',
  ];
  const messages = codes.map((code) => modelRefreshError(code, 'fallback'));
  expect(new Set(messages).size).toBe(4);
  expect(messages.every((message) => message.includes('OpenRouter'))).toBe(
    true,
  );
  expect(modelRefreshError('http_503', 'Сервіс тимчасово недоступний.')).toBe(
    'Сервіс тимчасово недоступний.',
  );
  expect(modelRefreshError()).toBe(uk.ai.error);
});
