import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { alignFrames } from "./capture-contract.js";
import { encodeAligned } from "./encoder.js";
import { FrameSpool } from "./spool.js";
import { verifyArtifacts } from "./verifier.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("multi-viewport encoder", () => {
  it("produces identical complete frame timelines", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoolypane-encoder-"));
    directories.push(directory);
    const tracks = await Promise.all(["one", "two", "three"].map(async (id, trackIndex) => {
      const geometry = [{ width: 320, height: 240 }, { width: 240, height: 320 }, { width: 180, height: 320 }][trackIndex]!;
      const jpeg = await sharp({ create: { width: geometry.width, height: geometry.height, channels: 3, background: "#ff0000" } }).jpeg().toBuffer();
      const spool = new FrameSpool(id, join(directory, "raw"));
      await spool.open();
      for (let sequence = 0; sequence < 10; sequence += 1) {
        await spool.append(jpeg, { sequence, width: geometry.width, height: geometry.height, timestampUs: sequence * (trackIndex + 1) * 20_000 });
      }
      await spool.close();
      const alignment = alignFrames(spool.index.frames, 0, 22, 30);
      return { id, spool, mappings: alignment.mappings, geometry: { id, encodedWidth: geometry.width, encodedHeight: geometry.height } };
    }));
    await encodeAligned(directory, tracks, 30, 22, { compositeMaxSize: { width: 640, height: 480 }, compositeBackground: "#111318" });
    const verification = await verifyArtifacts(directory, 30, 22);
    expect(verification.success, verification.error).toBe(true);
    expect(verification.ptsVector).toHaveLength(22);
  }, 30_000);
});
