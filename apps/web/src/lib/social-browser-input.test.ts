import { describe, expect, it } from 'vitest';
import { mapBrowserPoint } from './social-browser-input';

describe('mapBrowserPoint', () => {
  it('maps points from the rendered image to the remote viewport', () => {
    expect(
      mapBrowserPoint(300, 250, {
        left: 100,
        top: 50,
        width: 640,
        height: 400,
      }),
    ).toEqual({ x: 400, y: 400 });
  });

  it('clamps edge coordinates to the viewport', () => {
    expect(
      mapBrowserPoint(800, 600, { left: 0, top: 0, width: 640, height: 400 }),
    ).toEqual({ x: 1280, y: 800 });
  });
});
