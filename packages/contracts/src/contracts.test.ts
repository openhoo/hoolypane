import { describe, expect, it } from "vitest";
import { ActionEnvelopeSchema, ActionSchema, HoolypaneConfigSchema, VIEWPORT_PRESETS } from "./index.js";

describe("configuration", () => {
  it("applies all recording defaults", () => {
    const result = HoolypaneConfigSchema.parse({ viewports: [VIEWPORT_PRESETS[0]] });
    expect(result.timeoutMs).toBe(30_000);
    expect(result.recording).toEqual({
      fps: 60,
      jpegQuality: 85,
      layout: "grid",
      compositeMaxSize: { width: 3840, height: 2160 },
      compositeBackground: "#111318",
      outputDir: "hoolypane-results",
      keepRaw: false,
    });
  });

  it("rejects unsupported recording values", () => {
    expect(HoolypaneConfigSchema.safeParse({ viewports: [VIEWPORT_PRESETS[0]], recording: { fps: 24 } }).success).toBe(false);
    expect(HoolypaneConfigSchema.safeParse({ viewports: [VIEWPORT_PRESETS[0]], recording: { jpegQuality: 100.5 } }).success).toBe(false);
    expect(HoolypaneConfigSchema.safeParse({ viewports: [VIEWPORT_PRESETS[0]], recording: { layout: "rows" } }).success).toBe(false);
  });

  it("normalizes explicitly-undefined recording keys to defaults", () => {
    const result = HoolypaneConfigSchema.parse({ viewports: [VIEWPORT_PRESETS[0]], recording: { fps: undefined, outputDir: undefined } });
    expect(result.recording.fps).toBe(60);
    expect(result.recording.outputDir).toBe("hoolypane-results");
  });

});

describe("action language", () => {
  it("round-trips every action form", () => {
    const locator = { kind: "testId", value: "subject" } as const;
    const actions = [
      { kind: "navigate", url: "https://example.test" },
      { kind: "click", locator },
      { kind: "fill", locator, value: "hello" },
      { kind: "select", locator, values: ["one"] },
      { kind: "check", locator, checked: true },
      { kind: "press", locator, key: "Enter" },
      { kind: "scroll", locator, horizontalRatio: 0.25, verticalRatio: 0.75 },
    ];
    expect(actions.map((action) => ActionSchema.parse(action))).toEqual(actions);
    expect(ActionEnvelopeSchema.parse({ actionId: 1, documentGeneration: 0, sourcePaneId: "pane-1", action: actions[1], recordedAtUnixMs: 1 }).action.kind).toBe("click");
  });
});

describe("action language edge cases", () => {
  const locator = { kind: "testId", value: "subject" } as const;

  it("accepts an emptied multi-select as a deselect-all step", () => {
    expect(ActionSchema.parse({ kind: "select", locator, values: [] })).toEqual({ kind: "select", locator, values: [] });
  });

  it("restricts navigate URLs to http and https", () => {
    expect(ActionSchema.safeParse({ kind: "navigate", url: "https://example.test" }).success).toBe(true);
    expect(ActionSchema.safeParse({ kind: "navigate", url: "file:///etc/passwd" }).success).toBe(false);
    expect(ActionSchema.safeParse({ kind: "navigate", url: "javascript:alert(1)" }).success).toBe(false);
  });
});
