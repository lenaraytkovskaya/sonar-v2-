export const browserViewport = { width: 1280, height: 800 } as const;

export function mapBrowserPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
) {
  return {
    x: Math.max(
      0,
      Math.min(
        browserViewport.width,
        ((clientX - rect.left) / rect.width) * browserViewport.width,
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        browserViewport.height,
        ((clientY - rect.top) / rect.height) * browserViewport.height,
      ),
    ),
  };
}
