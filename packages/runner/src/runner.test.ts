import { describe, expect, it } from "vitest";
import { parseCliArguments } from "./cli-arguments.js";
import { buildContextOptions, validateResolvedConfig } from "./run-flow.js";
import { VIEWPORT_PRESETS } from "@hoolypane/contracts";

describe("runner CLI", () => {
  it("parses flow, config, output, and headed options", () => {
    expect(parseCliArguments(["run", "flows/example.ts", "--config", "custom.ts", "--output", "out", "--headed"])).toEqual({
      command: "run", flowFile: "flows/example.ts", configFile: "custom.ts", outputDir: "out", headed: true,
    });
  });

  it("rejects duplicate flags", () => {
    expect(() => parseCliArguments(["run", "flow.ts", "--headed", "--headed"])).toThrow(/once/);
    expect(() => parseCliArguments(["run", "flow.ts", "--config", "a", "--config", "b"])).toThrow(/once/);
  });
});

describe("runner preflight", () => {
  it("rejects duplicate viewport ids before launch", () => {
    const viewport = VIEWPORT_PRESETS[0]!;
    expect(() => validateResolvedConfig({ viewports: [viewport, viewport] })).toThrow(/duplicate viewport/i);
  });

  it("builds exact isolated context options", () => {
    const viewport = VIEWPORT_PRESETS.find((item) => item.id === "phone-390")!;
    const config = validateResolvedConfig({ viewports: [viewport] });
    const options = buildContextOptions(config, config.viewports[0]!);
    expect(options).toMatchObject({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    });
  });

  it("rejects invalid recording values during preflight", () => {
    expect(() => validateResolvedConfig({ viewports: [VIEWPORT_PRESETS[0]!], recording: { fps: 24 } })).toThrow();
  });
});
