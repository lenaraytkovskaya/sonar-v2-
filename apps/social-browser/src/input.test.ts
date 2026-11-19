import { describe, expect, it } from 'vitest';
import { browserLocale, parseBrowserAction } from './input.js';

describe('browser input validation', () => {
  it('accepts a reload action without parameters', () => {
    expect(parseBrowserAction({ type: 'reload' })).toEqual({ type: 'reload' });
  });

  it('accepts bounded pointer and wheel input', () => {
    expect(
      parseBrowserAction({ type: 'click', x: 1280, y: 800 }),
    ).toMatchObject({ type: 'click' });
    expect(
      parseBrowserAction({
        type: 'wheel',
        x: 40,
        y: 50,
        deltaX: 0,
        deltaY: 800,
      }),
    ).toMatchObject({ type: 'wheel' });
  });

  it('rejects out-of-bounds coordinates, invalid keys and oversized text', () => {
    expect(parseBrowserAction({ type: 'click', x: -1, y: 10 })).toBeNull();
    expect(parseBrowserAction({ type: 'click', x: 10, y: 801 })).toBeNull();
    expect(parseBrowserAction({ type: 'key', key: 'F12' })).toBeNull();
    expect(
      parseBrowserAction({ type: 'text', text: 'x'.repeat(4097) }),
    ).toBeNull();
    expect(
      parseBrowserAction({
        type: 'wheel',
        x: 1,
        y: 1,
        deltaX: 0,
        deltaY: 2001,
      }),
    ).toBeNull();
  });
});

describe('browser locale', () => {
  it('defaults to English for missing or invalid values', () => {
    expect(browserLocale(undefined)).toEqual({
      locale: 'en-US',
      acceptLanguage: 'en-US,en;q=0.9',
    });
    expect(browserLocale('en-US; drop')).toMatchObject({ locale: 'en-US' });
  });

  it('keeps a configured language with English as a fallback', () => {
    expect(browserLocale('uk-UA')).toEqual({
      locale: 'uk-UA',
      acceptLanguage: 'uk-UA,uk;q=0.9,en;q=0.8',
    });
  });
});
