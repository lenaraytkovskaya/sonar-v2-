export function selectedTab(
  query: Pick<URLSearchParams, 'get'>,
  parameter: string,
  keys: readonly string[],
  fallback: string,
) {
  const value = query.get(parameter);
  return value !== null && keys.includes(value) ? value : fallback;
}

export function tabUrl(href: string, parameter: string, key: string) {
  const url = new URL(href);
  if (key) url.searchParams.set(parameter, key);
  else url.searchParams.delete(parameter);
  return url.pathname + url.search + url.hash;
}
