import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import sharp from "sharp";
import { durationFrameCount } from "./capture-contract.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ViewportSpec } from "@hoolypane/contracts";
import type { FrameSpool } from "./spool.js";
import { RecordingSession, type RecordingTarget } from "./session.js";

class FakeTarget implements RecordingTarget {
  readonly id = "phone";
  readonly viewport: ViewportSpec = { id: "phone", name: "Phone", width: 64, height: 64, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
  private listener: ((params: unknown) => void) | undefined;

  async send(_method: string): Promise<unknown> { return {}; }
  on(_event: string, listener: (params: unknown) => void): void { this.listener = listener; }
  off(): void { this.listener = undefined; }
  emit(params: unknown): void { this.listener?.(params); }
}

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

function options(outputDir: string) {
  return { recording: { fps: 30 as const, jpegQuality: 85, compositeMaxSize: { width: 128, height: 128 }, compositeBackground: "#111318", keepRaw: false }, timeoutMs: 100, outputDir };
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

  it("routes close()-surfaced stream errors into a failed manifest instead of throwing", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "hoolypane-close-fail-"));
    directories.push(outputDir);
    const target = new FakeTarget();
    const session = new RecordingSession(options(outputDir));
    await session.start([target]);
    const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#00ff00" } }).jpeg().toBuffer();
    target.emit({ data: jpeg.toString("base64"), sessionId: 1, metadata: { timestamp: 1_800_000_000, deviceWidth: 2, deviceHeight: 2 } });
    await session.awaitInitialFrames();
    session.markFlowStart();
    // Fault injection reaches past compile-time-private internals, mirroring spool.test.ts.
    const sessionInternal = session as unknown as { contexts: { spool: FrameSpool }[] };
    const spool = sessionInternal.contexts[0]!.spool;
    const spoolInternal = spool as unknown as { stream?: Writable };
    const destroyed = spoolInternal.stream?.destroy(new Error("disk exploded"));
    expect(destroyed).toBeDefined();
    const flushed = Promise.withResolvers<void>();
    setImmediate(flushed.resolve);
    await flushed.promise;
    // Finalize must survive the close()-surfaced failure: align/encode still run and the
    // manifest records status "failed" instead of finalize throwing.
    const result = await session.finalize({ status: "success", failures: [] });
    expect(result.kind).toBe("manifest");
    if (result.kind === "manifest") {
      expect(result.manifest.status).toBe("failed");
      expect(result.manifest.failures.some((failure) => /capture spool close failed/.test(failure.message) && failure.viewportId === "phone")).toBe(true);
    }
  }, 30_000);

  it("clears stale outputs from a previous run before opening spools", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "hoolypane-stale-"));
    directories.push(outputDir);
    await mkdir(join(outputDir, "videos"), { recursive: true });
    await mkdir(join(outputDir, "traces"), { recursive: true });
    await writeFile(join(outputDir, "videos", "stale.webm"), "stale");
    await writeFile(join(outputDir, "traces", "stale.trace"), "stale");
    await writeFile(join(outputDir, "manifest.json"), "{}");
    await writeFile(join(outputDir, "diagnostics.json"), "{}");
    await writeFile(join(outputDir, "run-state.json"), "{}");
    const session = new RecordingSession(options(outputDir));
    await session.start([new FakeTarget()]);
    expect(existsSync(join(outputDir, "videos", "stale.webm"))).toBe(false);
    expect(existsSync(join(outputDir, "traces", "stale.trace"))).toBe(false);
    const state = JSON.parse(await readFile(join(outputDir, "run-state.json"), "utf8")) as { state: string };
    expect(state.state).toBe("awaiting-initial-frames");
    await session.finalize({ status: "failed", failures: [] });
  });

  it("removes raw bins and partial videos on keepRaw=false failure exits", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "hoolypane-prune-"));
    directories.push(outputDir);
    const target = new FakeTarget();
    const session = new RecordingSession(options(outputDir));
    await session.start([target]);
    // Created while capturing would be; start-time clearing cannot have removed these.
    await writeFile(join(outputDir, "raw", "phone.jpeg.bin"), "partial-bin");
    await mkdir(join(outputDir, "videos"), { recursive: true });
    await writeFile(join(outputDir, "videos", "partial.webm"), "partial-video");
    const result = await session.finalize({ status: "failed", failures: [{ message: "aborted" }] });
    expect(result.kind).toBe("diagnostics");
    expect(existsSync(join(outputDir, "raw"))).toBe(false);
    expect(existsSync(join(outputDir, "videos"))).toBe(false);
  });
});

describe("recording session guards", () => {
  it("rejects a duplicate start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoolypane-session-start-"));
    directories.push(directory);
    const target = new FakeTarget();
    const session = new RecordingSession(options(directory));
    await session.start([target]);
    await expect(session.start([target])).rejects.toThrow(/already started/);
    await session.finalize({ status: "failed", failures: [] }).catch(() => undefined);
  });
});
