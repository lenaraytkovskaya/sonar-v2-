import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BuildVersion } from './build-version';

describe('BuildVersion', () => {
  it('renders the app version and build sha with the build date as its title', () => {
    const html = renderToStaticMarkup(
      createElement(BuildVersion, {
        version: '2.1.0',
        sha: 'a1b2c3d',
        date: '2026-11-17',
      }),
    );

    expect(html).toContain('v2.1.0 · a1b2c3d');
    expect(html).toContain('title="2026-11-17"');
  });
});
