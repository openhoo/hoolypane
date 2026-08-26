import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { DEFAULT_COMPOSITE_BACKGROUND } from "@hoolypane/contracts";
import { compositeGeometry } from "./capture-contract.js";
import { encodeAligned } from "./encoder.js";
import { buildAlignedTracks, removeScratchDirectories, trackScratchDirectory } from "./test-support.js";
import { verifyArtifacts } from "./verifier.js";

afterEach(removeScratchDirectories);

interface RecordedTrackSpec { readonly id: string; readonly width: number; readonly height: number; readonly frames: number; readonly strideUs: number }

async function recordedTracks(directory: string, specs: readonly RecordedTrackSpec[], t0Us: number, durationFrames: number, fps: 30 | 60) {
  return buildAlignedTracks(directory, specs.map((spec) => {
    let reusedJpeg: Promise<Buffer> | undefined;
    return {
      id: spec.id,
      width: spec.width,
      height: spec.height,
      frames: spec.frames,
      // One red JPEG buffer per spec, appended for every sequence (previous inline-builder behavior).
      jpeg: () => (reusedJpeg ??= sharp({ create: { width: spec.width, height: spec.height, channels: 3, background: "#ff0000" } }).jpeg().toBuffer()),
      timestampUs: (sequence: number) => sequence * spec.strideUs,
    };
  }), t0Us, durationFrames, fps, { swallowCloseErrors: true });
}

describe("multi-viewport encoder", () => {
  it("produces identical complete frame timelines", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoolypane-encoder-"));
    trackScratchDirectory(directory);
    const tracks = await recordedTracks(directory, [
      { id: "one", width: 320, height: 240, frames: 10, strideUs: 20_000 },
      { id: "two", width: 240, height: 320, frames: 10, strideUs: 40_000 },
      { id: "three", width: 180, height: 320, frames: 10, strideUs: 60_000 },
    ], 0, 22, 30);
    await encodeAligned(directory, tracks, 30, 22, { compositeMaxSize: { width: 640, height: 480 }, compositeBackground: DEFAULT_COMPOSITE_BACKGROUND });
    const expectedComposite = compositeGeometry(tracks.map(({ geometry }) => geometry), { width: 640, height: 480 });
    const verification = await verifyArtifacts(directory, 30, 22, {
      tracks: tracks.map(({ geometry }) => geometry),
      composite: { width: expectedComposite.outputWidth, height: expectedComposite.outputHeight },
    });
    expect(verification.success, verification.error).toBe(true);
    const geometryFor = (file: string) => verification.geometry.find((entry) => entry.file === file);
    expect(geometryFor("one.webm")).toMatchObject({ width: 320, height: 240 });
    expect(geometryFor("two.webm")).toMatchObject({ width: 240, height: 320 });
    expect(geometryFor("three.webm")).toMatchObject({ width: 180, height: 320 });
    const composite = geometryFor("composite.webm");
    expect(composite!.width % 2).toBe(0);
    expect(composite!.height % 2).toBe(0);
    expect(composite!.width).toBeLessThanOrEqual(640);
    expect(composite!.height).toBeLessThanOrEqual(480);
  }, 30_000);

  it("rejects artifacts that disagree with the declared timeline or geometry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoolypane-verifier-reject-"));
    trackScratchDirectory(directory);
    const tracks = await recordedTracks(directory, [{ id: "solo", width: 64, height: 64, frames: 22, strideUs: 33_333 }], 0, 22, 30);
    await encodeAligned(directory, tracks, 30, 22, { compositeMaxSize: { width: 128, height: 128 }, compositeBackground: DEFAULT_COMPOSITE_BACKGROUND });
    const expected = {
      tracks: [{ id: "solo", encodedWidth: 64, encodedHeight: 64 }],
      composite: { width: 64, height: 64 },
    };
    const wrongFps = await verifyArtifacts(directory, 60, 22, expected);
    expect(wrongFps.success).toBe(false);
    expect(wrongFps.error).toMatch(/packet 1 pts \d+ deviates from the 60 fps constant-frame-rate timeline/u);
    const wrongCount = await verifyArtifacts(directory, 30, 21, expected);
    expect(wrongCount.success).toBe(false);
    expect(wrongCount.error).toMatch(/packet frame count mismatch/u);
    const wrongGeometry = await verifyArtifacts(directory, 30, 22, { ...expected, composite: { width: 320, height: 240 } });
    expect(wrongGeometry.success).toBe(false);
    expect(wrongGeometry.error).toMatch(/composite\.webm geometry .* differs from expected/u);
    const missingTrack = await verifyArtifacts(directory, 30, 22, { tracks: [{ id: "ghost", encodedWidth: 64, encodedHeight: 64 }], composite: { width: 64, height: 64 } });
    expect(missingTrack.success).toBe(false);
    expect(missingTrack.error).toMatch(/artifact set mismatch/u);
  }, 30_000);
});
