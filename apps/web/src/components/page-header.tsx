'use client';

import React, { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type PageHeaderTargets = {
  title: HTMLElement | null;
  actions: HTMLElement | null;
};

export const PageHeaderContext = createContext<PageHeaderTargets | undefined>(
  undefined,
);

/** Move page-owned headings and interactive actions into the shell's upper bar. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
}) {
  const targets = useContext(PageHeaderContext);
  const heading = (
    <div className="min-w-0">
      <h1 className="truncate font-heading text-sm font-bold">{title}</h1>
      <div className="truncate text-xs text-muted-foreground">
        {description}
      </div>
    </div>
  );
  if (!targets)
    return (
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        {heading}
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </header>
    );
  return (
    <>
      {targets.title && createPortal(heading, targets.title)}
      {targets.actions && actions && createPortal(actions, targets.actions)}
    </>
  );
}
