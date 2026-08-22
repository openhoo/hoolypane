import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArguments } from "./cli-arguments.js";
import { buildContextOptions, validateResolvedConfig } from "./run-flow.js";
import { verifyDirectory } from "./verify.js";
import ffmpegPath from "ffmpeg-static";
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


const scratchDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function runFfmpeg(args: readonly string[]): Promise<void> {
  const completion = Promise.withResolvers<void>();
  // ffmpeg-static's bundled typings do not promise a string; mirror the recorder's defensive resolution.
  const binary: unknown = ffmpegPath;
  if (typeof binary !== "string") throw new Error("ffmpeg-static path unavailable");
  const child = spawn(binary, args);
  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
  child.once("error", completion.reject);
  child.once("close", (code) => code === 0 ? completion.resolve() : completion.reject(new Error(`ffmpeg exited ${code}: ${stderr}`)));
  return completion.promise;
}
// Encodes one 64x64 CFR track plus a composite through the same filter chain the recorder uses.
async function writeRecordingFixture(directory: string, fps: 30 | 60, frames: number): Promise<void> {
  await mkdir(join(directory, "videos"), { recursive: true });
  const framesFile = join(directory, "frames.mjpeg");
  await runFfmpeg(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=16x16", "-frames:v", String(frames), "-c:v", "mjpeg", "-f", "image2pipe", framesFile]);
  const scale = "scale=64:64:force_original_aspect_ratio=decrease,pad=64:64:(ow-iw)/2:(oh-ih)/2:color=0x111318";
  const filter = `[0:v]settb=AVTB,setpts=N/(${fps}*TB),split=2[raw0][gridraw0];[raw0]${scale}[track0];[gridraw0]${scale}[tile0];[tile0]scale=64:64[composite]`;
  const outputOptions = ["-an", "-frames:v", String(frames), "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-fps_mode", "passthrough"];
  await runFfmpeg([
    "-hide_banner", "-loglevel", "error", "-y",
    "-probesize", "32", "-analyzeduration", "0", "-c:v", "mjpeg", "-f", "image2pipe", "-framerate", String(fps), "-i", framesFile,
    "-filter_complex", filter,
    ...outputOptions, "-map", "[track0]", join(directory, "videos", "one.webm"),
    ...outputOptions, "-map", "[composite]", join(directory, "videos", "composite.webm"),
  ]);
}

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
    scratchDirectories.push(directory);
    await writeRecordingFixture(directory, 30, 22);
    await writeFile(join(directory, "manifest.json"), manifestBody({}));
    expect(await verifyDirectory(directory)).toBe(0);
  }, 30_000);

  it("wraps an unparsable or missing manifest with its path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoolypane-verify-broken-"));
    scratchDirectories.push(directory);
    await writeFile(join(directory, "manifest.json"), "{not json");
    await expect(verifyDirectory(directory)).rejects.toThrow(/Cannot parse .*manifest\.json/);
    await expect(verifyDirectory(join(directory, "missing"))).rejects.toThrow(/missing.*manifest\.json/s);
  });

  it("rejects manifests lacking or holding invalid timeline keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoolypane-verify-keys-"));
    scratchDirectories.push(directory);
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ status: "success" }));
    await expect(verifyDirectory(directory)).rejects.toThrow(/lacks fps or durationFrames/u);
    await writeFile(join(directory, "manifest.json"), manifestBody({ fps: 24 }));
    await expect(verifyDirectory(directory)).rejects.toThrow(/invalid fps or durationFrames/u);
    await writeFile(join(directory, "manifest.json"), manifestBody({ durationFrames: 0 }));
    await expect(verifyDirectory(directory)).rejects.toThrow(/invalid fps or durationFrames/u);
  });

  it("fails verification when artifacts disagree with the manifest contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoolypane-verify-mismatch-"));
    scratchDirectories.push(directory);
    await writeRecordingFixture(directory, 30, 22);
    await writeFile(join(directory, "manifest.json"), manifestBody({ durationFrames: 21 }));
    await expect(verifyDirectory(directory)).rejects.toThrow(/packet frame count mismatch/u);
    await writeFile(join(directory, "manifest.json"), manifestBody({ viewports: [{ id: "one", encodedWidth: 128, encodedHeight: 64 }] }));
    await expect(verifyDirectory(directory)).rejects.toThrow(/geometry .* differs from expected/u);
  }, 30_000);
});
