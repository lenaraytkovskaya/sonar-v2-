export function filterUrl(
  href: string,
  values: Iterable<[string, FormDataEntryValue]>,
  names: Iterable<string>,
) {
  const url = new URL(href);
  for (const name of [...names, 'page', 'conversation', 'form'])
    url.searchParams.delete(name);
  for (const [name, value] of values)
    if (typeof value === 'string' && value.trim())
      url.searchParams.append(name, value.trim());
  return url.pathname + url.search + url.hash;
}
