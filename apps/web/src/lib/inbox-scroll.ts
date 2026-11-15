export function isNearBottom(element: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
}
/** Status edits and repeated snapshots are not new messages. */
export function newMessageCount(previous: string[], next: string[]) {
  const known = new Set(previous);
  return next.filter((id) => !known.has(id)).length;
}
