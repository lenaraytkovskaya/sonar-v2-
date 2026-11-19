import { describe, expect, it } from 'vitest';
import { parseBrowserAction } from './input.js';

describe('browser input validation', () => {
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
