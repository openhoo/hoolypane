import type { ChromeState, PanePosition } from "@hoolypane/contracts";

export const LAYOUT_PADDING = 8;

/** Single padded-domain clamp shared by free-tile restore and keyboard nudges: a committed coordinate always renders where the native view sits. */
export function clampPanePosition(value: number, areaExtent: number, size: number): number {
  return Math.max(LAYOUT_PADDING, Math.min(areaExtent - LAYOUT_PADDING - size, value));
}

const LAYOUT_GAP = 8;
export const PANE_HEADER_HEIGHT = 28;

export interface PaneTile {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Content scale the emulation will apply; shown as a zoom chip when below 100%. */
  readonly zoom: number;
  /** Zero-size marker for focus-layout siblings; their cards stay mounted but invisible. */
  readonly hidden?: boolean;
}

interface TileInput {
  readonly id: string;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

function tileFor(input: TileInput, cellWidth: number, cellHeight: number, x: number, y: number): PaneTile {
  // cellHeight is the FULL card extent (header included): clamping zoom against the content area
  // keeps height-clamped cards exactly filling the cell, so centering never yields a negative
  // offset (the old math pushed cards above the padding origin, e.g. y=-6 in focus layout).
  const contentHeight = Math.max(0, cellHeight - PANE_HEADER_HEIGHT);
  const zoom = Math.max(0, Math.min(1, cellWidth / input.viewportWidth, contentHeight / input.viewportHeight));
  const width = Math.round(input.viewportWidth * zoom);
  const height = Math.round(PANE_HEADER_HEIGHT + input.viewportHeight * zoom);
  return {
    id: input.id,
    x: Math.round(x + Math.max(0, (cellWidth - width) / 2)),
    y: Math.round(y + Math.max(0, (cellHeight - height) / 2)),
    width,
    height,
    zoom,
  };
}

/**
 * Tiles panes proportionally to their viewport aspect ratios (Polypane-style): cards are sized to the
 * scaled viewport instead of uniform grid cells, so a 1440×900 desktop site never shares cell
 * dimensions with a 390×844 phone. The grid column count maximizes covered area, which also degrades
 * gracefully in small tiled windows. Every pane receives an entry: focus-mode siblings get explicit
 * zero-size hidden tiles so their cards stay mounted and the bounds contract holds.
 */
export function computePaneTiles(
  layout: ChromeState["layout"],
  areaWidth: number,
  areaHeight: number,
  panes: readonly TileInput[],
  focusedPaneId: string | null,
  positions: Readonly<Record<string, PanePosition>>,
): Map<string, PaneTile> {
  const tiles = new Map<string, PaneTile>();
  const innerWidth = areaWidth - LAYOUT_PADDING * 2;
  const innerHeight = areaHeight - LAYOUT_PADDING * 2;
  if (innerWidth <= 0 || innerHeight <= 0 || panes.length === 0) return tiles;
  if (layout === "focus") return focusTiles(panes, focusedPaneId, innerWidth, innerHeight);
  if (layout === "horizontal") return rowTiles(panes, innerWidth, innerHeight);
  restoreFreePositions(tiles, masonryTiles(panes, innerWidth, innerHeight), positions, areaWidth, areaHeight);
  return tiles;
}

/** Focus layout: one visible aspect-fitted card plus explicit zero-size hidden siblings. */
function focusTiles(
  panes: readonly TileInput[],
  focusedPaneId: string | null,
  innerWidth: number,
  innerHeight: number,
): Map<string, PaneTile> {
  const tiles = new Map<string, PaneTile>();
  const visible = focusedPaneId === null ? panes[0] : panes.find((pane) => pane.id === focusedPaneId) ?? panes[0];
  if (visible) tiles.set(visible.id, tileFor(visible, innerWidth, innerHeight, LAYOUT_PADDING, LAYOUT_PADDING));
  // Explicit zero-size entries keep sibling cards mounted so surfaces.length always matches
  // expectedSurfaceCount and bounds emission never stalls.
  for (const pane of panes) {
    if (visible !== undefined && pane.id === visible.id) continue;
    tiles.set(pane.id, { id: pane.id, x: 0, y: 0, width: 0, height: 0, zoom: 1, hidden: true });
  }
  return tiles;
}

/** Horizontal row: height-fit zoom per pane, uniformly shrunk when the row overflows. */
function rowTiles(panes: readonly TileInput[], innerWidth: number, innerHeight: number): Map<string, PaneTile> {
  const tiles = new Map<string, PaneTile>();
  const contentHeight = innerHeight - PANE_HEADER_HEIGHT;
  // Height-fit zoom per pane, then a uniform fit so the row cannot overflow the workspace:
  // window-truncated rects would collapse emulation scale for clipped edge panes.
  const heightZoom = (pane: TileInput): number => Math.max(0, Math.min(1, contentHeight / pane.viewportHeight));
  const rowWidth =
    panes.reduce((sum, pane) => sum + pane.viewportWidth * heightZoom(pane), 0) + LAYOUT_GAP * (panes.length - 1);
  const fit = Math.min(1, innerWidth / Math.max(1, rowWidth));
  let x = LAYOUT_PADDING;
  for (const pane of panes) {
    const zoom = heightZoom(pane) * fit;
    const width = Math.round(pane.viewportWidth * zoom);
    tiles.set(pane.id, tileFor(pane, width, innerHeight, x, LAYOUT_PADDING));
    x += width + LAYOUT_GAP;
  }
  return tiles;
}

/**
 * Column masonry search: tries every column count, keeps the arrangement with the best covered
 * area, and scales toward the padding origin when it overshoots the workspace height (the fixed
 * header band stays unscaled so overscaled cards still show their full header).
 */
function masonryTiles(panes: readonly TileInput[], innerWidth: number, innerHeight: number): PaneTile[] {
  // Column masonry (Polypane-style): cards keep their viewport aspect ratio at a shared column
  // width, and each card is placed in the currently shortest column. This packs mixed landscape/
  // portrait viewports without row-band dead space; the whole arrangement scales down only when it
  // overshoots the workspace height.
  let bestCoverage = -1;
  let bestPlacement: PaneTile[] = [];
  for (let columns = 1; columns <= panes.length; columns += 1) {
    const cellWidth = (innerWidth - LAYOUT_GAP * (columns - 1)) / columns;
    if (cellWidth <= 0) continue;
    const widthZoom = (pane: TileInput): number => Math.min(1, cellWidth / pane.viewportWidth);
    const columnHeights: number[] = Array.from({ length: columns }, () => LAYOUT_PADDING);
    const placement: PaneTile[] = [];
    for (const pane of panes) {
      const zoom = widthZoom(pane);
      const width = Math.round(pane.viewportWidth * zoom);
      const height = Math.round(PANE_HEADER_HEIGHT + pane.viewportHeight * zoom);
      const shortest = columnHeights.indexOf(Math.min(...columnHeights));
      const shortestHeight = columnHeights[shortest]!;
      const columnX = LAYOUT_PADDING + shortest * (cellWidth + LAYOUT_GAP);
      placement.push({ id: pane.id, x: Math.round(columnX + (cellWidth - width) / 2), y: Math.round(shortestHeight), width, height, zoom });
      columnHeights[shortest] = shortestHeight + height + LAYOUT_GAP;
    }
    const totalHeight = columnHeights.reduce((tallest, current) => Math.max(tallest, current), 0) - LAYOUT_GAP;
    const fit = Math.min(1, innerHeight / totalHeight);
    const coverage = panes.reduce((sum, pane) => {
      const zoom = widthZoom(pane) * fit;
      return sum + pane.viewportWidth * zoom * pane.viewportHeight * zoom;
    }, 0) / (innerWidth * innerHeight);
    if (coverage <= bestCoverage) continue;
    bestCoverage = coverage;
    // Overshoot: scale the arrangement toward the padding origin; the fixed header band is kept
    // unscaled while the content share shrinks, so rendered headers never clip.
    bestPlacement = placement.map((tile) => ({
      ...tile,
      x: Math.round(LAYOUT_PADDING + (tile.x - LAYOUT_PADDING) * fit),
      y: Math.round(LAYOUT_PADDING + (tile.y - LAYOUT_PADDING) * fit),
      width: Math.round(tile.width * fit),
      height: Math.round(PANE_HEADER_HEIGHT + (tile.height - PANE_HEADER_HEIGHT) * fit),
      zoom: tile.zoom * fit,
    }));
  }
  return bestPlacement;
}

/** Applies stored free positions on top of freshly packed masonry tiles, clamped to the extent. */
function restoreFreePositions(
  tiles: Map<string, PaneTile>,
  placed: readonly PaneTile[],
  positions: Readonly<Record<string, PanePosition>>,
  areaWidth: number,
  areaHeight: number,
): void {
  for (const tile of placed) {
    const stored = positions[tile.id];
    if (!stored) { tiles.set(tile.id, tile); continue; }
    // Restored free positions must be clamped onto the CURRENT workspace extent, otherwise a
    // stale saved position after a window resize pushes panes outside and the native view
    // collapses to 1×1.
    const x = clampPanePosition(stored.x, areaWidth, tile.width);
    const y = clampPanePosition(stored.y, areaHeight, tile.height);
    tiles.set(tile.id, { ...tile, x, y });
  }
}
