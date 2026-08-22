import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { durationFrameCount } from "./capture-contract.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ViewportSpec } from "@hoolypane/contracts";
import { RecordingSession, type RecordingTarget } from "./session.js";

class FakeTarget implements RecordingTarget {
  readonly id = "phone";
  readonly viewport: ViewportSpec = { id: "phone", name: "Phone", width: 64, height: 64, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
  readonly commands: string[] = [];
  private listener: ((params: unknown) => void) | undefined;

  async send(method: string): Promise<unknown> { this.commands.push(method); return {}; }
  on(_event: string, listener: (params: unknown) => void): void { this.listener = listener; }
  off(): void { this.listener = undefined; }
  emit(params: unknown): void { this.listener?.(params); }
}

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

function options(outputDir: string) {
  return { recording: { fps: 30 as const, jpegQuality: 85, layout: "grid" as const, compositeMaxSize: { width: 128, height: 128 }, compositeBackground: "#111318", keepRaw: false }, timeoutMs: 100, outputDir };
}

describe("recording session", () => {
  it("writes diagnostics only when T0 was never established", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "hoolypane-pre-t0-"));
    directories.push(outputDir);
    const session = new RecordingSession(options(outputDir));
    await session.start([new FakeTarget()]);
    const result = await session.finalize({ status: "failed", failures: [{ message: "before initial frame" }] });
    expect(result.kind).toBe("diagnostics");
    if (result.kind === "diagnostics") {
      const payload = JSON.parse(await readFile(result.diagnosticsPath, "utf8")) as unknown;
      expect(payload).toEqual({ contract: null, status: "failed", failures: [{ message: "before initial frame" }] });
    }
  });

  it("encodes and validates a post-T0 partial run", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "hoolypane-post-t0-"));
    directories.push(outputDir);
    const target = new FakeTarget();
    const session = new RecordingSession(options(outputDir));
    await session.start([target]);
    const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#0088ff" } }).jpeg().toBuffer();
    target.emit({ data: jpeg.toString("base64"), sessionId: 1, metadata: { timestamp: 1_800_000_000, deviceWidth: 2, deviceHeight: 2 } });
    await session.awaitInitialFrames();
    session.markFlowStart();
    const result = await session.finalize({ status: "interrupted", failures: [{ message: "SIGINT" }] });
    expect(result.kind).toBe("manifest");
    if (result.kind === "manifest") {
      expect(result.manifest).toMatchObject({ contract: "multi-viewport-cfr-v1", validationSuccess: true, status: "interrupted" });
      expect(result.manifest.durationFrames).toBe(durationFrameCount(result.manifest.t0UnixUs, result.manifest.t1UnixUs, result.manifest.fps));
    }
  }, 30_000);
});
