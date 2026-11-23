import React, { type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PageHeader, PageHeaderContext } from './page-header';

const { portal } = vi.hoisted(() => ({
  portal: vi.fn<(children: ReactNode, target: HTMLElement) => null>(() => null),
}));
vi.mock('react-dom', () => ({ createPortal: portal }));

beforeEach(() => portal.mockClear());

describe('PageHeader shell slots', () => {
  it('places the heading and actions in their shell targets without a content copy', () => {
    const titleTarget = {} as HTMLElement;
    const actionsTarget = {} as HTMLElement;
    const html = renderToStaticMarkup(
      <PageHeaderContext.Provider
        value={{ title: titleTarget, actions: actionsTarget }}
      >
        <main>
          <PageHeader
            title="Компанії"
            description="Знайдені компанії"
            actions={<button>Додати компанію</button>}
          />
          <p>Content</p>
        </main>
      </PageHeaderContext.Provider>,
    );
    expect(html).toBe('<main><p>Content</p></main>');
    expect(portal).toHaveBeenCalledTimes(2);
    expect(portal.mock.calls[0]?.[1]).toBe(titleTarget);
    expect(portal.mock.calls[1]?.[1]).toBe(actionsTarget);
    const heading = renderToStaticMarkup(portal.mock.calls[0]?.[0]);
    expect(heading).toContain('<h1');
    expect(heading).toContain('Компанії');
    expect(heading).toContain('Знайдені компанії');
    expect(renderToStaticMarkup(portal.mock.calls[1]?.[0])).toContain(
      '<button>Додати компанію</button>',
    );
  });

  it('waits for the shell targets instead of adding a second heading during hydration', () => {
    expect(
      renderToStaticMarkup(
        <PageHeaderContext.Provider value={{ title: null, actions: null }}>
          <PageHeader title="Канали" description="Акаунти команди" />
        </PageHeaderContext.Provider>,
      ),
    ).toBe('');
    expect(portal).not.toHaveBeenCalled();
  });

  it('omits an empty actions slot and works outside the shell', () => {
    renderToStaticMarkup(
      <PageHeaderContext.Provider
        value={{ title: {} as HTMLElement, actions: {} as HTMLElement }}
      >
        <PageHeader title="Канали" description="Акаунти команди" />
      </PageHeaderContext.Provider>,
    );
    expect(portal).toHaveBeenCalledTimes(1);
    const fallback = renderToStaticMarkup(
      <PageHeader title="Канали" description="Акаунти команди" />,
    );
    expect(fallback).toContain('<header');
    expect(fallback).toContain('Канали');
  });
});
