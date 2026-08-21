import { describe, expect, it } from "vitest";
import { VIEWPORT_PRESETS } from "@hoolypane/contracts";
import { displayScale, validateBoundsSnapshot } from "./layout.js";
import { normalizeUrl } from "./url.js";
import { addPane, defaultWorkspace, reorderPane, rotatePane } from "./workspace.js";

describe("desktop pane state", () => {
  it("normalizes bare hosts and rejects unsafe protocols", () => {
    expect(normalizeUrl("example.test/path")).toBe("https://example.test/path");
    expect(() => normalizeUrl("file:///etc/passwd")).toThrow(/http/);
  });

  it("computes direct-surface geometry", () => {
    expect(displayScale(390, 844, 390, 844)).toBe(1);
    expect(displayScale(195, 422, 390, 844)).toBe(0.5);
    expect(() => validateBoundsSnapshot({ windowWidth: 100, windowHeight: 100, panes: [{ paneId: "one", bounds: { x: 90, y: 0, width: 20, height: 20 } }] }, ["one"])).toThrow(/exceed/);
  });

  it("adds, rotates, and reorders immutable pane metadata", () => {
    const base = { ...defaultWorkspace(), panes: [], order: [] };
    const first = addPane(base, VIEWPORT_PRESETS[0]!, "https://example.test");
    const second = addPane(first, VIEWPORT_PRESETS[2]!, "https://example.test");
    const rotated = rotatePane(second, second.order[1]!);
    expect(rotated.panes[1]?.viewport).toMatchObject({ width: 1024, height: 768 });
    expect(reorderPane(rotated, second.order[1]!, 0).order).toEqual([second.order[1], second.order[0]]);
  });
});
