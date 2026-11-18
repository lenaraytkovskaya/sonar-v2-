import { describe, expect, it } from 'vitest';
import { parseViberChatUrl, viberChatUrl } from './viber.js';

describe('Viber chat links', () => {
  it('encodes and parses an E.164 recipient and draft', () => {
    const value = viberChatUrl(
      '+380501234567',
      'Привіт, світ!\nТак, Unicode 😊',
    );
    expect(value).toContain('viber://chat?');
    expect(parseViberChatUrl(value)).toEqual({
      to: '+380501234567',
      text: 'Привіт, світ!\nТак, Unicode 😊',
    });
  });

  it('rejects invalid recipients and malformed links', () => {
    expect(() => viberChatUrl('0501234567', 'hello')).toThrow();
    expect(() =>
      parseViberChatUrl('viber://chat?number=abc&draft=x'),
    ).toThrow();
  });
});
