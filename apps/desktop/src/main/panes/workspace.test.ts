import { describe, expect, it } from "vitest";
import { VIEWPORT_PRESETS } from "@hoolypane/contracts";
import { displayScale, validateBoundsSnapshot } from "./layout.js";
import { normalizeUrl } from "./url.js";
import { addPane, closePane, defaultWorkspace, removePane, rotatePane, uniquePaneId } from "./workspace.js";

describe("desktop pane state", () => {
  it("normalizes bare hosts and rejects unsafe protocols", () => {
    expect(normalizeUrl("example.test/path")).toBe("https://example.test/path");
    expect(normalizeUrl("https://user:token@example.test/")).toBe("https://example.test/");
    expect(() => normalizeUrl("file:///etc/passwd")).toThrow(/http/);
  });

  it("computes direct-surface geometry", () => {
    expect(displayScale(390, 844, 390, 844)).toBe(1);
    expect(displayScale(195, 422, 390, 844)).toBe(0.5);
    expect(() => validateBoundsSnapshot({ windowWidth: 100, windowHeight: 100, panes: [{ paneId: "one", bounds: { x: 90, y: 0, width: 20, height: 20 } }] }, ["one"])).toThrow(/exceed/);
  });

  it("adds and rotates immutable pane metadata", () => {
    const base = { ...defaultWorkspace(), panes: [], order: [] };
    const first = addPane(base, VIEWPORT_PRESETS[0]!, "https://example.test");
    const second = addPane(first, VIEWPORT_PRESETS[2]!, "https://example.test");
    const rotated = rotatePane(second, second.order[1]!);
    expect(rotated.panes[1]?.viewport).toMatchObject({ width: 1024, height: 768 });
    expect(second.panes[1]?.viewport).toMatchObject({ width: 768, height: 1024 });
    expect(rotated).not.toBe(second);
    expect(rotated.panes[1]).not.toBe(second.panes[1]);
  });

  it("returns guarded closes untouched and cleans up removals completely", () => {
    const base = { ...defaultWorkspace(), panes: [], order: [] };
    const first = addPane(base, VIEWPORT_PRESETS[0]!, "https://example.test");
    const two = addPane(first, VIEWPORT_PRESETS[2]!, "https://example.test");
    expect(closePane(two, "unknown")).toBe(two);
    expect(removePane(two, "unknown")).toBe(two);
    const single = { ...two, panes: two.panes.slice(0, 1), order: two.order.slice(0, 1) };
    expect(closePane(single, single.order[0]!)).toBe(single);

    const focused = { ...two, layout: "focus" as const, focusedPaneId: two.order[1]! };
    const closedFocused = closePane(focused, focused.order[1]!);
    expect(closedFocused.focusedPaneId).toBeNull();
    expect(closedFocused.layout).toBe("grid");

    const positioned = { ...two, focusedPaneId: two.order[1]!, positions: { ...two.positions, [two.order[0]!]: { x: 12, y: 34 } } };
    const kept = closePane(positioned, two.order[0]!);
    expect(kept.focusedPaneId).toBe(two.order[1]);
    expect(kept.positions[two.order[0]!]).toBeUndefined();
  });

  it("skips used suffixes when deriving unique pane ids", () => {
    expect(uniquePaneId(new Set(["p", "p-2"]), "p")).toBe("p-3");
    expect(uniquePaneId(new Set(["p"]), "p")).toBe("p-2");
    expect(uniquePaneId(new Set<string>(), "p")).toBe("p");
    const base = { ...defaultWorkspace(), panes: [], order: [] };
    const twice = addPane(addPane(base, VIEWPORT_PRESETS[4]!, "https://example.test"), VIEWPORT_PRESETS[4]!, "https://example.test");
    expect(twice.order[1]).toBe(`${twice.order[0]}-2`);
  });
});
