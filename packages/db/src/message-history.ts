/** Shared forward/reverse order for every message-history reader. */
export function messageHistoryOrder(
  direction: 'asc' | 'desc',
  qualified = false,
) {
  const p = qualified ? 'm.' : '',
    nulls = direction === 'asc' ? 'first' : 'last';
  return `((${p}social_meta->>'facebookInboxOrder') is null) ${direction},(${p}social_meta->>'facebookInboxOrder')::int ${direction},${p}created_at ${direction},(${p}social_meta->>'providerOrder')::int ${direction} nulls ${nulls},${p}id ${direction}`;
}
