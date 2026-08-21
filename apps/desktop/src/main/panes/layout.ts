import type { BoundsSnapshot } from "@hoolypane/contracts";

export type Bounds = { x: number; y: number; width: number; height: number };

export function displayScale(availableWidth: number, availableHeight: number, width: number, height: number): number {
  if (availableWidth <= 0 || availableHeight <= 0 || width <= 0 || height <= 0) return 0;
  return Math.min(1, availableWidth / width, availableHeight / height);
}

export function validateBoundsSnapshot(snapshot: BoundsSnapshot, paneIds: readonly string[]): void {
  if (snapshot.panes.length !== paneIds.length) throw new Error("bounds snapshot must contain every pane");
  const expected = new Set(paneIds);
  const seen = new Set<string>();
  for (const item of snapshot.panes) {
    if (!expected.has(item.paneId) || seen.has(item.paneId)) throw new Error(`unknown or duplicate pane in bounds: ${item.paneId}`);
    seen.add(item.paneId);
    const { x, y, width, height } = item.bounds;
    if (x + width > snapshot.windowWidth || y + height > snapshot.windowHeight) throw new Error(`pane ${item.paneId} bounds exceed window`);
  }
}
