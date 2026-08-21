import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { alignFrames } from "../../packages/recorder/src/capture-contract.js";
import { encodeAligned } from "../../packages/recorder/src/encoder.js";
import { FrameSpool } from "../../packages/recorder/src/spool.js";
import { verifyArtifacts } from "../../packages/recorder/src/verifier.js";

const OUTPUT = resolve(process.env.HOOLYPANE_BENCHMARK_OUTPUT ?? ".tmp/recording-proof");
const FPS = 60 as const;
const DURATION_FRAMES = 600;

describe("ten-second recording contract", () => {
  it("encodes four unequal-rate sources into exact aligned timelines", async () => {
    await rm(OUTPUT, { recursive: true, force: true });
    await mkdir(OUTPUT, { recursive: true });
    const baselineRss = process.memoryUsage().rss;
    const specifications = [
      { id: "desktop", width: 160, height: 90, sourceFps: 60, color: "#d63f3f" },
      { id: "tablet", width: 90, height: 160, sourceFps: 30, color: "#3f7fd6" },
      { id: "phone", width: 96, height: 160, sourceFps: 20, color: "#42a35a" },
      { id: "compact", width: 72, height: 128, sourceFps: 12, color: "#9a4ec2" },
    ] as const;
    const tracks = await Promise.all(specifications.map(async (specification) => {
      const spool = new FrameSpool(specification.id, resolve(OUTPUT, "raw"));
      await spool.open();
      const frames = specification.sourceFps * 10;
      for (let sequence = 0; sequence < frames; sequence += 1) {
        const jpeg = await sharp({ create: { width: specification.width, height: specification.height, channels: 3, background: specification.color } })
          .composite([{ input: Buffer.from(`<svg width="${specification.width}" height="${specification.height}"><text x="4" y="18" fill="white" font-size="14">${sequence}</text></svg>`) }])
          .jpeg({ quality: 70 })
          .toBuffer();
        await spool.append(jpeg, { sequence, width: specification.width, height: specification.height, timestampUs: Math.floor(sequence * 1_000_000 / specification.sourceFps) });
      }
      await spool.close();
      const alignment = alignFrames(spool.index.frames, 0, DURATION_FRAMES, FPS);
      return { id: specification.id, spool, mappings: alignment.mappings, geometry: { id: specification.id, encodedWidth: specification.width, encodedHeight: specification.height } };
    }));
    await encodeAligned(OUTPUT, tracks, FPS, DURATION_FRAMES, { compositeMaxSize: { width: 320, height: 320 }, compositeBackground: "#111318" });
    const verification = await verifyArtifacts(OUTPUT, FPS, DURATION_FRAMES);
    expect(verification.success, verification.error).toBe(true);
    expect(verification.ptsVector).toHaveLength(DURATION_FRAMES);
    expect(process.memoryUsage().rss - baselineRss).toBeLessThan(256 * 1024 * 1024);
    await writeFile(resolve(OUTPUT, "manifest.json"), `${JSON.stringify({ contract: "multi-viewport-cfr-v1", validatorVersion: 1, validationSuccess: true, fps: FPS, durationFrames: DURATION_FRAMES, artifacts: verification.artifacts, sha256: verification.sha256 }, null, 2)}\n`);
  }, 120_000);
});
