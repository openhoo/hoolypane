import { describe, expect, it } from "vitest";
import { VIEWPORT_PRESETS } from "@hoolypane/contracts";
import { clampPanePosition, computePaneTiles, LAYOUT_GAP, LAYOUT_PADDING, PANE_HEADER_HEIGHT, type PaneTile } from "./layout.js";

const inputs = (specs: readonly { id: string; width: number; height: number }[]) =>
  specs.map((spec) => ({ id: spec.id, viewportWidth: spec.width, viewportHeight: spec.height }));
const ALL_INPUTS = inputs(VIEWPORT_PRESETS);

// Grid/free/focus pack inside the padding origin and extent except under severe compression:
// horizontal rows may pass the right padding ((n - 1) * LAYOUT_GAP of unscaled gaps plus up to
// half-a-pixel-per-pane of Math.round surplus), and masonry packs may pass the bottom padding
// (unscaled 28px header band) within the provable universal envelope y + height <= areaHeight -
// LAYOUT_PADDING + PANE_HEADER_HEIGHT.
function expectPaddedDomain(tiles: Map<string, PaneTile>, areaWidth: number, areaHeight: number): void {
  for (const tile of tiles.values()) {
    if (tile.hidden) continue;
    expect(tile.x, `${tile.id} left`).toBeGreaterThanOrEqual(LAYOUT_PADDING);
    expect(tile.y, `${tile.id} top`).toBeGreaterThanOrEqual(LAYOUT_PADDING);
    expect(tile.x + tile.width, `${tile.id} right`).toBeLessThanOrEqual(areaWidth - LAYOUT_PADDING);
    expect(tile.y + tile.height, `${tile.id} bottom`).toBeLessThanOrEqual(areaHeight - LAYOUT_PADDING);
  }
}

describe("renderer layout engine", () => {
  it("tiles every pane inside the padded domain across generated layouts and roomy workspaces", () => {
    const areas = [
      [1600, 1000],
      [1920, 1080],
      [3200, 2000],
    ] as const;
    for (const [areaWidth, areaHeight] of areas) {
      for (const layout of ["grid", "free", "focus"] as const) {
        const focusedPaneId = layout === "focus" ? VIEWPORT_PRESETS[2]!.id : null;
        const tiles = computePaneTiles(layout, areaWidth, areaHeight, ALL_INPUTS, focusedPaneId, {});
        expect([...tiles.keys()].sort(), `${layout} @ ${areaWidth}x${areaHeight}`).toEqual(
          ALL_INPUTS.map((input) => input.id).sort(),
        );
        expectPaddedDomain(tiles, areaWidth, areaHeight);
      }
    }
  });

  it("keeps heavily compressed grid packs inside the workspace with intact header bands", () => {
    // Under severe masonry compression the unscaled 28px header band pushes the deepest card
    // past the bottom padding (scaled bottom = 36 + (span - 36) * fit exceeds the domain once
    // fit drops below ~28/36). Headers never clip; widths carry no unscaled band, so
    // left/right/top stay inside the padded domain, and every bottom respects the derived
    // universal ceiling below: drift past the padding is caused solely by the retained
    // unscaled header band.
    const areas = [
      [1280, 800],
      [628, 420],
    ] as const;
    for (const [areaWidth, areaHeight] of areas) {
      const tiles = computePaneTiles("grid", areaWidth, areaHeight, ALL_INPUTS, null, {});
      expect(tiles.size, `${areaWidth}x${areaHeight}`).toBe(ALL_INPUTS.length);
      for (const tile of tiles.values()) {
        expect(tile.x, `${tile.id} left`).toBeGreaterThanOrEqual(LAYOUT_PADDING);
        expect(tile.y, `${tile.id} top`).toBeGreaterThanOrEqual(LAYOUT_PADDING);
        expect(tile.x + tile.width, `${tile.id} right`).toBeLessThanOrEqual(areaWidth - LAYOUT_PADDING);
        expect(tile.height, `${tile.id} header band`).toBeGreaterThanOrEqual(PANE_HEADER_HEIGHT);
        expect(tile.y + tile.height, `${tile.id} inside workspace`).toBeLessThanOrEqual(areaHeight);
        expect(tile.y + tile.height, `${tile.id} unscaled-header envelope`).toBeLessThanOrEqual(
          areaHeight - LAYOUT_PADDING + PANE_HEADER_HEIGHT,
        );
      }
    }
  });

  it("lays horizontal rows side by side inside the padded domain when they naturally fit", () => {
    const twoDesktops = inputs([VIEWPORT_PRESETS[0]!, VIEWPORT_PRESETS[1]!]);
    const tiles = computePaneTiles("horizontal", 3200, 1000, twoDesktops, null, {});
    expect([...tiles.values()].map((tile) => tile.id)).toEqual(twoDesktops.map((input) => input.id));
    expect(tiles.get(twoDesktops[0]!.id)!.x).toBeLessThan(tiles.get(twoDesktops[1]!.id)!.x);
    expectPaddedDomain(tiles, 3200, 1000);
  });

  it("compresses overflowing horizontal rows uniformly and keeps only the unscaled gaps at the right edge", () => {
    const areaWidth = 1280;
    const areaHeight = 800;
    const tiles = computePaneTiles("horizontal", areaWidth, areaHeight, ALL_INPUTS, null, {});
    expect(tiles.size).toBe(ALL_INPUTS.length);
    let rightmost = 0;
    for (const tile of tiles.values()) {
      expect(tile.x, `${tile.id} left`).toBeGreaterThanOrEqual(LAYOUT_PADDING);
      expect(tile.y, `${tile.id} top`).toBeGreaterThanOrEqual(LAYOUT_PADDING);
      expect(tile.y + tile.height, `${tile.id} bottom`).toBeLessThanOrEqual(areaHeight - LAYOUT_PADDING);
      rightmost = Math.max(rightmost, tile.x + tile.width);
    }
    // Row widths shrink by the uniform fit but the fixed 8px gaps between cards do not, and each
    // Math.round adds up to half a pixel of surplus, so the compressed row may exceed the right
    // padding by (n - 1) * LAYOUT_GAP of unscaled gaps plus up to half-a-pixel-per-pane of
    // Math.round surplus (three 1358px panes at width 141 land one pixel past the gap-only
    // envelope). This pins the known drift instead of hiding it behind a looser bound.
    expect(rightmost).toBeLessThanOrEqual(
      areaWidth - LAYOUT_PADDING + (ALL_INPUTS.length - 1) * LAYOUT_GAP + Math.ceil(ALL_INPUTS.length / 2),
    );
  });

  it("keeps focus layout to one visible card plus zero-size hidden siblings, falling back past stale ids", () => {
    const panes = inputs(VIEWPORT_PRESETS.slice(0, 3));
    const focusedId = panes[1]!.id;
    const focused = computePaneTiles("focus", 1280, 800, panes, focusedId, {});
    expect(focused.size).toBe(panes.length);
    expect([...focused.values()].filter((tile) => !tile.hidden).map((tile) => tile.id)).toEqual([focusedId]);
    for (const tile of focused.values()) {
      if (tile.id === focusedId) continue;
      expect(tile).toEqual({ id: tile.id, x: 0, y: 0, width: 0, height: 0, zoom: 1, hidden: true });
    }
    // Null and stale focused ids both fall back to the first ordered pane.
    for (const staleFocus of [null, "stale-id"]) {
      const fallback = computePaneTiles("focus", 1280, 800, panes, staleFocus, {});
      expect([...fallback.values()].filter((tile) => !tile.hidden).map((tile) => tile.id)).toEqual([panes[0]!.id]);
    }
  });

  it("never places the focus card above the padding origin for extreme aspect ratios", () => {
    const ultraWide = [{ id: "wide", viewportWidth: 2560, viewportHeight: 600 }];
    const tiles = computePaneTiles("focus", 400, 300, ultraWide, null, {});
    const visible = [...tiles.values()].filter((tile) => !tile.hidden);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.y).toBeGreaterThanOrEqual(LAYOUT_PADDING);
    expectPaddedDomain(tiles, 400, 300);
  });

  it("keeps the header band unscaled when masonry overshoots the workspace height", () => {
    const phone = VIEWPORT_PRESETS[4]!;
    // Distinct ids: tiles are keyed by input id, so same-viewport panes still need identity.
    const fourPhones = [1, 2, 3, 4].map((n) => ({ id: `phone-${n}`, viewportWidth: phone.width, viewportHeight: phone.height }));
    // Four 360x800 stacks cannot fit 500px of height without scaling down.
    const squeezed = computePaneTiles("grid", 800, 500, fourPhones, null, {});
    expect(squeezed.size).toBe(fourPhones.length);
    let showsScaledContent = false;
    for (const tile of squeezed.values()) {
      expect(tile.height, `${tile.id} header band`).toBeGreaterThanOrEqual(PANE_HEADER_HEIGHT);
      expect(tile.zoom).toBeLessThan(1);
      if (tile.height > PANE_HEADER_HEIGHT) showsScaledContent = true;
      expect(tile.y + tile.height).toBeLessThanOrEqual(500 - LAYOUT_PADDING);
    }
    expect(showsScaledContent).toBe(true);
    // The same panes in a roomy area render fully unscaled.
    const roomy = computePaneTiles("grid", 900, 3400, fourPhones, null, {});
    for (const tile of roomy.values()) expect(tile.zoom).toBe(1);
  });

  it("restores stored free positions verbatim and clamps stale ones onto the current extent", () => {
    const movedId = ALL_INPUTS[0]!.id;
    const auto = computePaneTiles("free", 2000, 1400, ALL_INPUTS, null, {});
    const stored = computePaneTiles("free", 2000, 1400, ALL_INPUTS, null, { [movedId]: { x: 64, y: 96 } });
    expect(stored.get(movedId)).toEqual({ ...auto.get(movedId)!, x: 64, y: 96 });
    // Panes without a stored entry keep their freshly packed placement.
    expect(stored.get(ALL_INPUTS[1]!.id)).toEqual(auto.get(ALL_INPUTS[1]!.id));
    const stale = computePaneTiles("free", 2000, 1400, ALL_INPUTS, null, { [movedId]: { x: 999_999, y: 999_999 } });
    expectPaddedDomain(stale, 2000, 1400);
    const tile = stale.get(movedId)!;
    expect(tile.x).toBe(clampPanePosition(999_999, 2000, tile.width));
    expect(tile.y).toBe(clampPanePosition(999_999, 1400, tile.height));
    // An empty position record packs exactly like the generated grid layout.
    expect(computePaneTiles("free", 1280, 800, ALL_INPUTS, null, {})).toEqual(
      computePaneTiles("grid", 1280, 800, ALL_INPUTS, null, {}),
    );
  });

  it("clamps positions into the padded domain with a hard floor when the extent is tiny", () => {
    expect(clampPanePosition(-50, 800, 100)).toBe(LAYOUT_PADDING);
    expect(clampPanePosition(400, 800, 100)).toBe(400);
    expect(clampPanePosition(900, 800, 100)).toBe(800 - LAYOUT_PADDING - 100);
    expect(clampPanePosition(0, 20, 30)).toBe(LAYOUT_PADDING);
  });

  it("returns no tiles for degenerate workspaces", () => {
    expect(computePaneTiles("grid", 12, 12, ALL_INPUTS, null, {}).size).toBe(0);
    expect(computePaneTiles("grid", LAYOUT_PADDING * 2, 800, ALL_INPUTS, null, {}).size).toBe(0);
    expect(computePaneTiles("grid", 1280, 800, [], null, {}).size).toBe(0);
  });
});
