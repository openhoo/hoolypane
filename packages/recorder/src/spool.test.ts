import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { ViewportSpec } from "@hoolypane/contracts";
import { MAX_QUEUED_BYTES, MAX_QUEUED_FRAMES } from "./capture-contract.js";
import { CaptureSpool, FrameSpool } from "./spool.js";
import { RecordingSession, type RecordingTarget } from "./session.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const FRAME = Buffer.alloc(16, 7);
const frameMeta = (sequence: number) => ({ sequence, width: 2, height: 2, timestampUs: sequence * 20_000 });

// Fault injection requires reaching past the compile-time-private stream handle.
function streamOf(spool: FrameSpool): Writable | undefined {
  return (spool as unknown as { stream?: Writable }).stream;
}

describe("frame spool", () => {
  it("drops over-cap frames without rejecting: acks proceed, drops counted, notes throttled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoolypane-spool-cap-"));
    directories.push(directory);
    const spool = new FrameSpool("capped", directory);
    await spool.open();
    const attempts = Array.from({ length: MAX_QUEUED_FRAMES + 1 }, (_unused, sequence) =>
      spool.append(FRAME, frameMeta(sequence)).then(() => null, (error: unknown) => error),
    );
    // Every over-cap frame resolves so the upstream screencast ack keeps flowing.
    const outcomes = await Promise.all(attempts);
    expect(outcomes.every((outcome) => outcome === null)).toBe(true);
    expect(spool.index.frames).toHaveLength(MAX_QUEUED_FRAMES);
    expect(spool.index.droppedFrames).toBe(1);
    // Accepted frames keep contiguous offsets; the dropped one consumed neither slot nor budget.
    await expect(spool.append(FRAME, frameMeta(MAX_QUEUED_FRAMES + 1))).resolves.toMatchObject({ offset: MAX_QUEUED_FRAMES * FRAME.length });

    // The byte cap stays a hard rejection.
    const oversized = Buffer.alloc(MAX_QUEUED_BYTES + 1, 3);
    await expect(spool.append(oversized, frameMeta(99))).rejects.toThrow(/queue cap exceeded/);

    const notes = [...spool.drainFailureNotes()];
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ viewportId: "capped", message: expect.stringMatching(/dropped 1 over-cap frame/) });
    expect(spool.drainFailureNotes()).toEqual([]);

    await spool.close();
    const persisted = JSON.parse(await readFile(join(directory, "capped.index.json"), "utf8")) as { frames: unknown[]; droppedFrames: number };
    expect(persisted.frames).toHaveLength(MAX_QUEUED_FRAMES + 1);
    expect(persisted.droppedFrames).toBe(1);
    // Recording artifacts are private to the owning user.
    expect(((await stat(join(directory, "capped.index.json"))).mode & 0o777)).toBe(0o600);
    expect(((await stat(join(directory, "capped.jpeg.bin"))).mode & 0o777)).toBe(0o600);
  });

  it("poisons failure state on write errors: later appends reject, records stay out of the index", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoolypane-spool-poison-"));
    directories.push(directory);
    const spool = new FrameSpool("poisoned", directory);
    await spool.open();
    await expect(spool.append(FRAME, frameMeta(0))).resolves.toMatchObject({ sequence: 0 });
    streamOf(spool)?.destroy(new Error("disk exploded"));
    await new Promise((resolve) => setImmediate(resolve));
    await expect(spool.append(FRAME, frameMeta(1))).rejects.toThrow(/disk exploded|destroyed/i);
    expect(spool.index.frames).toHaveLength(1);
    await expect(spool.close()).rejects.toThrow(/disk exploded|destroyed/i);
    const persisted = JSON.parse(await readFile(join(directory, "poisoned.index.json"), "utf8")) as { frames: unknown[] };
    expect(persisted.frames).toHaveLength(1);
  });

  it("writes the index exactly once across repeated closes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoolypane-spool-close-"));
    directories.push(directory);
    const spool = new FrameSpool("once", directory);
    await spool.open();
    await spool.append(FRAME, frameMeta(0));
    await spool.close();
    const firstWrite = await readFile(join(directory, "once.index.json"), "utf8");
    spool.index.frames.push({ ...frameMeta(99), offset: 999, length: 1 });
    await spool.close();
    expect(await readFile(join(directory, "once.index.json"), "utf8")).toBe(firstWrite);
  });

  it("rolls back a duplicate create without leaving index files behind", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoolypane-spool-rollback-"));
    directories.push(directory);
    const capture = new CaptureSpool();
    const target = (id: string): RecordingTarget => ({
      id,
      viewport: { id, name: id, width: 64, height: 64, deviceScaleFactor: 1, isMobile: false, hasTouch: false } satisfies ViewportSpec,
      send: async () => undefined,
      on: () => undefined,
      off: () => undefined,
    });
    await expect(capture.create([target("dup"), target("dup")], directory)).rejects.toThrow(/duplicate capture target id/);
    expect(capture.spools.size).toBe(0);
    const files = await readdir(directory);
    expect(files.filter((file) => file.endsWith(".index.json"))).toEqual([]);
  });
});

describe("recording session guards", () => {
  it("rejects a duplicate start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoolypane-session-start-"));
    directories.push(directory);
    const target: RecordingTarget = {
      id: "phone",
      viewport: { id: "phone", name: "Phone", width: 64, height: 64, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
      send: async () => undefined,
      on: () => undefined,
      off: () => undefined,
    };
    const session = new RecordingSession({
      recording: { fps: 30, jpegQuality: 85, layout: "grid", compositeMaxSize: { width: 128, height: 128 }, compositeBackground: "#111318", keepRaw: false },
      timeoutMs: 100,
      outputDir: directory,
    });
    await session.start([target]);
    await expect(session.start([target])).rejects.toThrow(/already started/);
    await session.finalize({ status: "failed", failures: [] }).catch(() => undefined);
  });
});
