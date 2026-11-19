export const viewport = { width: 1280, height: 800 } as const;

export const allowedKeys = new Set([
  'Enter',
  'Tab',
  'Backspace',
  'Delete',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
]);

export type BrowserAction =
  | { type: 'reload' }
  | {
      type: 'move' | 'down' | 'up' | 'click' | 'doubleClick';
      x: number;
      y: number;
      button?: 'left' | 'middle' | 'right';
    }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: string; selectAll?: boolean };

export function isCoordinate(value: unknown, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= max
  );
}

export function parseBrowserAction(
  input: Record<string, unknown>,
): BrowserAction | null {
  const type = input.type;
  if (type === 'reload') return { type };
  if (type === 'text') {
    return typeof input.text === 'string' && input.text.length <= 4096
      ? { type, text: input.text }
      : null;
  }
  if (type === 'key') {
    return input.selectAll === true
      ? { type, key: 'a', selectAll: true }
      : typeof input.key === 'string' && allowedKeys.has(input.key)
        ? { type, key: input.key }
        : null;
  }
  if (
    ['move', 'down', 'up', 'click', 'doubleClick', 'wheel'].includes(
      String(type),
    )
  ) {
    if (
      !isCoordinate(input.x, viewport.width) ||
      !isCoordinate(input.y, viewport.height)
    )
      return null;
    if (type === 'wheel') {
      if (
        typeof input.deltaX !== 'number' ||
        !Number.isFinite(input.deltaX) ||
        Math.abs(input.deltaX) > 2000 ||
        typeof input.deltaY !== 'number' ||
        !Number.isFinite(input.deltaY) ||
        Math.abs(input.deltaY) > 2000
      )
        return null;
      return {
        type: 'wheel',
        x: input.x,
        y: input.y,
        deltaX: input.deltaX,
        deltaY: input.deltaY,
      };
    }
    const button = input.button;
    if (
      button !== undefined &&
      !['left', 'middle', 'right'].includes(String(button))
    )
      return null;
    return {
      type: type as 'move' | 'down' | 'up' | 'click' | 'doubleClick',
      x: input.x,
      y: input.y,
      ...(button ? { button: button as 'left' | 'middle' | 'right' } : {}),
    };
  }
  return null;
}
