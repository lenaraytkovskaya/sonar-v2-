'use client';
import { useEffect, useId, type ReactNode } from 'react';
import { useUrlTab } from './use-url-tab';
import { uk } from '@/i18n/uk';
import { Button } from './ui/button';

// The company page supplies Server Component slots; only tab selection is client state.
export function CompanyTabs({
  tabs,
}: {
  tabs: { key: string; label: string; content: ReactNode }[];
}) {
  const id = useId();
  const { active, select, visited } = useUrlTab(
    tabs.map((tab) => tab.key),
    tabs[0]?.key ?? '',
  );
  useEffect(() => {
    document.getElementById(`${id}-tab-${active}`)?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
  }, [id, active]);
  return (
    <div className="min-w-0 space-y-4">
      <div
        role="tablist"
        aria-label={uk.company.tabs}
        className="flex gap-2 overflow-x-auto p-1"
      >
        {tabs.map((tab, index) => (
          <Button
            key={tab.key}
            id={`${id}-tab-${tab.key}`}
            type="button"
            role="tab"
            aria-selected={active === tab.key}
            aria-controls={`${id}-panel-${tab.key}`}
            tabIndex={active === tab.key ? 0 : -1}
            variant={active === tab.key ? 'default' : 'outline'}
            className="min-h-11 shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={(event) => {
              select(tab.key);
              event.currentTarget.scrollIntoView({
                block: 'nearest',
                inline: 'nearest',
              });
            }}
            onKeyDown={(event) => {
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : event.key === 'ArrowRight'
                      ? (index + 1) % tabs.length
                      : event.key === 'ArrowLeft'
                        ? (index - 1 + tabs.length) % tabs.length
                        : undefined;
              if (next === undefined) return;
              event.preventDefault();
              const target = tabs[next];
              if (!target) return;
              select(target.key);
              document.getElementById(`${id}-tab-${target.key}`)?.focus();
            }}
          >
            {tab.label}
          </Button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.key}
          id={`${id}-panel-${tab.key}`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-${tab.key}`}
          hidden={active !== tab.key}
          tabIndex={0}
        >
          {/* Retain visited forms and drafts until the company key changes. */}
          {(active === tab.key || visited.includes(tab.key)) && tab.content}
        </div>
      ))}
    </div>
  );
}
