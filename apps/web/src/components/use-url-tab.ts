'use client';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { selectedTab, tabUrl } from '@/lib/url-tab';

export function useUrlTab(
  keys: readonly string[],
  fallback: string,
  parameter = 'tab',
  aliases: Readonly<Record<string, string>> = {},
) {
  const query = useSearchParams();
  const active = selectedTab(query, parameter, keys, fallback, aliases);
  const [visited, setVisited] = useState([active]);
  useEffect(() => {
    setVisited((previous) =>
      previous.includes(active) ? previous : [...previous, active],
    );
  }, [active]);
  const select = (key: string) => {
    if (key === active || !keys.includes(key)) return;
    // Next synchronizes native history with useSearchParams without a server navigation.
    window.history.pushState(
      null,
      '',
      tabUrl(window.location.href, parameter, key),
    );
  };
  return { active, select, visited };
}
