export function selectedTab(
  query: Pick<URLSearchParams, 'get'>,
  parameter: string,
  keys: readonly string[],
  fallback: string,
  aliases: Readonly<Record<string, string>> = {},
) {
  const raw = query.get(parameter);
  const value = raw === null ? null : (aliases[raw] ?? raw);
  return value !== null && keys.includes(value) ? value : fallback;
}

export function tabUrl(href: string, parameter: string, key: string) {
  const url = new URL(href);
  if (key) url.searchParams.set(parameter, key);
  else url.searchParams.delete(parameter);
  return url.pathname + url.search + url.hash;
}
