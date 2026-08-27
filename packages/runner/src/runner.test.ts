import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCliArguments } from "./cli-arguments.js";
import { buildContextOptions } from "./run-flow.js";
import { compileModule } from "./module-loader.js";
import { verifyDirectory } from "./verify.js";
import ffmpegPath from "ffmpeg-static";
import { DEFAULT_COMPOSITE_BACKGROUND, HoolypaneConfigSchema, VIEWPORT_PRESETS } from "@hoolypane/contracts";
import { awaitChildExit, ffmpegArguments, filterGraph, removeScratchDirectories, trackScratchDirectory } from "@hoolypane/recorder";

describe("runner CLI", () => {
  it("parses flow, config, output, and headed options", () => {
    expect(parseCliArguments(["run", "flows/example.ts", "--config", "custom.ts", "--output", "out", "--headed"])).toEqual({
      flowFile: "flows/example.ts", configFile: "custom.ts", outputDir: "out", headed: true,
    });
  });

  it("rejects duplicate flags", () => {
    expect(() => parseCliArguments(["run", "flow.ts", "--headed", "--headed"])).toThrow(/once/);
    expect(() => parseCliArguments(["run", "flow.ts", "--config", "a", "--config", "b"])).toThrow(/once/);
  });
  it("pins one distinct error per argument-parse failure site", () => {
    expect(() => parseCliArguments(["verify", "out"])).toThrow(/^Usage:/u);
    expect(() => parseCliArguments(["run"])).toThrow(/^Usage:/u);
    expect(() => parseCliArguments(["run", "--headed"])).toThrow(/^Usage:/u);
    expect(() => parseCliArguments(["run", "flow.ts", "--config"])).toThrow(/--config requires a path/u);
    expect(() => parseCliArguments(["run", "flow.ts", "--config", "-x"])).toThrow(/--config requires a path/u);
    expect(() => parseCliArguments(["run", "flow.ts", "--output"])).toThrow(/--output requires a path/u);
    expect(() => parseCliArguments(["run", "flow.ts", "--output", "a", "--output", "b"])).toThrow(/--output may be specified only once/u);
    expect(() => parseCliArguments(["run", "flow.ts", "stray"])).toThrow(/Unknown argument: stray/u);
  });
});

describe("cli help", () => {
  // Requires the runner-wave CLI contract: usage lists run AND verify, -h/--help exits 0.
  it("prints the combined usage and exits 0 for -h and --help", async () => {
    const originalArgv = process.argv;
    const chunks: string[] = [];
    const sink = (chunk: Uint8Array | string) => {
      chunks.push(String(chunk));
      return true;
    };
    const outWrite = vi.spyOn(process.stdout, "write").mockImplementation(sink);
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(sink);
    try {
      // Dynamic import keeps this test independent of cli.js's entry-guard side effects;
      // main() reads process.argv at call time, so the help argv is observed below.
      process.argv = [originalArgv[0]!, "hoolypane", "--help"];
      const { main } = await import("./cli.js");
      await expect(main()).resolves.toBe(0);
      process.argv = [originalArgv[0]!, "hoolypane", "-h"];
      await expect(main()).resolves.toBe(0);
      const usage = chunks.join("");
      expect(usage).toMatch(/^Usage:/mu);
      expect(usage).toMatch(/\brun\b/u);
      expect(usage).toMatch(/\bverify\b/u);
    } finally {
      outWrite.mockRestore();
      errWrite.mockRestore();
      process.argv = originalArgv;
    }
  });
});

describe("runner preflight", () => {
  it("rejects duplicate viewport ids before launch", () => {
    const viewport = VIEWPORT_PRESETS[0]!;
    expect(() => HoolypaneConfigSchema.parse({ viewports: [viewport, viewport] })).toThrow(/duplicate viewport/i);
  });

  it("builds exact isolated context options", () => {
    const viewport = VIEWPORT_PRESETS.find((item) => item.id === "phone-390")!;
    const config = HoolypaneConfigSchema.parse({ viewports: [viewport] });
    const options = buildContextOptions(config, config.viewports[0]!);
    expect(options).toEqual({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    });
  });

  it("rejects invalid recording values during preflight", () => {
    expect(() => HoolypaneConfigSchema.parse({ viewports: [VIEWPORT_PRESETS[0]!], recording: { fps: 24 } })).toThrow();
  });
});

describe("compiled artifact loading", () => {
  it("exposes playwright named exports from the compiled bundle", async () => {
    // Dynamic import is the point of this test: it exercises Node's runtime loading boundary for
    // compiled artifacts exactly like runFlow does, which a static import could not observe.
    const directory = await mkdtemp(join(tmpdir(), "hoolypane-pw-artifact-"));
    trackScratchDirectory(directory);
    const source = join(directory, "flow.ts");
    await writeFile(source, 'import { chromium } from "playwright";\nexport const run = () => chromium.name();\n', "utf8");
    const compiled = await compileModule(source, join(directory, ".hoolypane/cache"));
    try {
      const mod = await import(pathToFileURL(compiled.path).href);
      expect(typeof mod.run).toBe("function");
      expect(mod.run()).toBe("chromium");
    } finally {
      await compiled.cleanup();
    }
  });
});


afterEach(removeScratchDirectories);

function runFfmpeg(args: readonly string[]): Promise<void> {
  // ffmpeg-static's bundled typings do not promise a string; mirror the recorder's defensive resolution.
  const binary: unknown = ffmpegPath;
  if (typeof binary !== "string") throw new Error("ffmpeg-static path unavailable");
  const child = spawn(binary, args);
  return awaitChildExit(child, child.stderr!, `ffmpeg ${binary}`).completion.promise;
}
const FIXTURE_TRACK_SIZE = 64;
// Both stub shapes feed pure argv builders that read only id/geometry fields; spools and
// mappings are consumed solely by the frame pump, which never runs in these tests.
const stubTrackGrid = () => ({
  tracks: [
    {
      id: "one",
      spool: null,
      mappings: [],
      geometry: { id: "one", encodedWidth: FIXTURE_TRACK_SIZE, encodedHeight: FIXTURE_TRACK_SIZE },
    },
  ],
  grid: {
    columns: 1,
    rows: 1,
    tileWidth: FIXTURE_TRACK_SIZE,
    tileHeight: FIXTURE_TRACK_SIZE,
    unscaledWidth: FIXTURE_TRACK_SIZE,
    unscaledHeight: FIXTURE_TRACK_SIZE,
    outputWidth: FIXTURE_TRACK_SIZE,
    outputHeight: FIXTURE_TRACK_SIZE,
  },
});

// Encodes one 64x64 CFR track plus a composite using @hoolypane/recorder's exported
// production filter_complex builder over a single-track stub, while feeding real files
// instead of input pipes; the parity test below pins the assembled argv tail to the
// encoder's production builders so encoder drift fails loudly here.
function recordingEncodeArguments(directory: string, fps: 30 | 60, frames: number): readonly string[] {
  const stubs = stubTrackGrid();
  const tracks = stubs.tracks as unknown as Parameters<typeof filterGraph>[0];
  const grid = stubs.grid as unknown as Parameters<typeof filterGraph>[1];
  const outputOptions = ["-an", "-frames:v", String(frames), "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-fps_mode", "passthrough"];
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    "-probesize", "32", "-analyzeduration", "0", "-c:v", "mjpeg", "-f", "image2pipe", "-framerate", String(fps), "-i", join(directory, "frames.mjpeg"),
    "-filter_complex", filterGraph(tracks, grid, fps, DEFAULT_COMPOSITE_BACKGROUND),
    "-map", "[track0]", ...outputOptions, join(directory, "videos", "one.webm"),
    "-map", "[composite]", ...outputOptions, join(directory, "videos", "composite.webm"),
  ];
}

async function writeRecordingFixture(directory: string, fps: 30 | 60, frames: number): Promise<void> {
  await mkdir(join(directory, "videos"), { recursive: true });
  await runFfmpeg(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=16x16", "-frames:v", String(frames), "-c:v", "mjpeg", "-f", "image2pipe", join(directory, "frames.mjpeg")]);
  await runFfmpeg(recordingEncodeArguments(directory, fps, frames));
}

describe("recording fixture parity", () => {
  it("pins the fixture argv to the encoder's filter graph and output options", () => {
    const stubs = stubTrackGrid();
    const tracks = stubs.tracks as unknown as Parameters<typeof ffmpegArguments>[1];
    const grid = stubs.grid as unknown as Parameters<typeof ffmpegArguments>[2];
    for (const fps of [30, 60] as const) {
      const directory = "fixture-parity-unused"; // Pure argv assembly: nothing spawns or writes.
      const emitted = recordingEncodeArguments(directory, fps, 22);
      const expected = ffmpegArguments(directory, tracks, grid, fps, 22, DEFAULT_COMPOSITE_BACKGROUND);
      const anchor = expected.indexOf("-filter_complex");
      // Both layers of the real construction path are pinned: the encoder argv embeds exactly
      // the standalone filterGraph(...) chain for the same track spec, and the fixture's tail
      // equals that argv positionally from the chain onward (chain, maps, options, paths).
      expect(expected.slice(anchor, anchor + 2)).toEqual(["-filter_complex", filterGraph(tracks, grid, fps, DEFAULT_COMPOSITE_BACKGROUND)]);
      expect(emitted.slice(emitted.indexOf("-filter_complex"))).toEqual(expected.slice(anchor));
    }
  });
});

function manifestBody(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    fps: 30,
    durationFrames: 22,
    viewports: [{ id: "one", encodedWidth: 64, encodedHeight: 64 }],
    geometry: { outputWidth: 64, outputHeight: 64 },
    ...overrides,
  });
}

describe("verify command", () => {
  it("verifies a real recording directory and returns success", async ({ }) => {
    const directory = await mkdtemp(join(tmpdir(), "hoolypane-verify-ok-"));
    trackScratchDirectory(directory);
    await writeRecordingFixture(directory, 30, 22);
    await writeFile(join(directory, "manifest.json"), manifestBody({}));
    expect(await verifyDirectory(directory)).toBe(0);
  }, 30_000);

  it("verifies a valid single-frame recording (public durationFrames>=1 contract)", async ({ }) => {
    const directory = await mkdtemp(join(tmpdir(), "hoolypane-verify-one-frame-"));
    trackScratchDirectory(directory);
    await writeRecordingFixture(directory, 30, 1);
    await writeFile(join(directory, "manifest.json"), manifestBody({ durationFrames: 1 }));
    expect(await verifyDirectory(directory)).toBe(0);
  }, 30_000);

  it("wraps an unparsable or missing manifest with its path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoolypane-verify-broken-"));
    trackScratchDirectory(directory);
    await writeFile(join(directory, "manifest.json"), "{not json");
    await expect(verifyDirectory(directory)).rejects.toThrow(/Cannot parse .*manifest\.json/);
    await expect(verifyDirectory(join(directory, "missing"))).rejects.toThrow(/missing.*manifest\.json/s);
  });

  it("rejects manifests lacking or holding invalid timeline keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoolypane-verify-keys-"));
    trackScratchDirectory(directory);
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ status: "success" }));
    await expect(verifyDirectory(directory)).rejects.toThrow(/lacks fps or durationFrames/u);
    await writeFile(join(directory, "manifest.json"), manifestBody({ fps: 24 }));
    await expect(verifyDirectory(directory)).rejects.toThrow(/invalid fps or durationFrames/u);
    await writeFile(join(directory, "manifest.json"), manifestBody({ durationFrames: 0 }));
    await expect(verifyDirectory(directory)).rejects.toThrow(/invalid fps or durationFrames/u);
  });

  it("fails verification when artifacts disagree with the manifest contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoolypane-verify-mismatch-"));
    trackScratchDirectory(directory);
    await writeRecordingFixture(directory, 30, 22);
    await writeFile(join(directory, "manifest.json"), manifestBody({ durationFrames: 21 }));

    await expect(verifyDirectory(directory)).rejects.toThrow(/packet frame count mismatch/u);
    await writeFile(join(directory, "manifest.json"), manifestBody({ viewports: [{ id: "one", encodedWidth: 128, encodedHeight: 64 }] }));
    await expect(verifyDirectory(directory)).rejects.toThrow(/geometry .* differs from expected/u);
  }, 30_000);

  it("fails loudly on a present-but-malformed viewports field instead of degrading to timeline-only", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoolypane-verify-malformed-"));
    trackScratchDirectory(directory);
    await writeFile(join(directory, "manifest.json"), manifestBody({ viewports: "not-an-array" }));
    await expect(verifyDirectory(directory)).rejects.toThrow(/malformed viewports field/u);
  });

  it("fails loudly on a malformed viewports entry missing its encoded width", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoolypane-verify-malformed-entry-"));
    trackScratchDirectory(directory);
    await writeFile(join(directory, "manifest.json"), manifestBody({ viewports: [{ id: "one", encodedWidth: 64 }] }));
    await expect(verifyDirectory(directory)).rejects.toThrow(/malformed viewports\[0\] entry/u);
  });

  it("fails loudly on a malformed geometry field", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoolypane-verify-malformed-geometry-"));
    trackScratchDirectory(directory);
    await writeFile(join(directory, "manifest.json"), manifestBody({ geometry: { outputWidth: 64 } }));
    await expect(verifyDirectory(directory)).rejects.toThrow(/malformed geometry field/u);
  });

  it("certifies the manifest sha256 map: mismatched or missing artifacts fail loudly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoolypane-verify-sha256-"));
    trackScratchDirectory(directory);
    await writeRecordingFixture(directory, 30, 22);
    const digestOf = async (key: string): Promise<readonly [string, string]> => [
      key,
      createHash("sha256").update(await readFile(join(directory, key))).digest("hex"),
    ];
    const sha256 = Object.fromEntries(await Promise.all(["videos/one.webm", "videos/composite.webm"].map(digestOf)));
    await writeFile(join(directory, "manifest.json"), manifestBody({ sha256 }));
    expect(await verifyDirectory(directory)).toBe(0);
    // A payload diverging from its certified digest (corruption/tampering) must fail loudly
    // even though ffprobe CFR/geometry agreement alone would certify the directory.
    await writeFile(join(directory, "manifest.json"), manifestBody({ sha256: { ...sha256, "videos/composite.webm": "0".repeat(64) } }));
    await expect(verifyDirectory(directory)).rejects.toThrow(/videos\/composite\.webm fails sha256 certification/u);
    // A listed-but-missing artifact fails the same way instead of being silently skipped.
    await writeFile(join(directory, "manifest.json"), manifestBody({ viewports: undefined, geometry: undefined, sha256: { "run-state.json": "0".repeat(64) } }));
    await expect(verifyDirectory(directory)).rejects.toThrow(/run-state\.json fails sha256 certification/u);
  }, 30_000);

  it("rejects manifests whose own status records a non-success run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoolypane-verify-status-"));
    trackScratchDirectory(directory);
    // The status gate runs before artifact verification, so an empty scratch directory suffices;
    // the two failure entries exercise both reasons renderings (string message vs JSON fallback).
    await writeFile(join(directory, "manifest.json"), manifestBody({ status: "failed", failures: [{ message: "capture ended early" }, { code: 7 }] }));
    await expect(verifyDirectory(directory)).rejects.toThrow(/records status "failed": capture ended early; \{"code":7\}/u);
  });
});
