import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
  it("rejects beyond the queue caps without corrupting counters or offsets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoolypane-spool-cap-"));
    directories.push(directory);
    const spool = new FrameSpool("capped", directory);
    await spool.open();
    const attempts = Array.from({ length: MAX_QUEUED_FRAMES + 1 }, (_unused, sequence) =>
      spool.append(FRAME, frameMeta(sequence)).then(() => null, (error: unknown) => error),
    );
    const outcomes = await Promise.all(attempts);
    const rejections = outcomes.filter((outcome): outcome is Error => outcome instanceof Error);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ message: `capture queue cap exceeded for capped` });
    // Every accepted frame kept its sequential slot; the rejected one consumed neither offset nor queue budget.
    await spool.append(FRAME, frameMeta(MAX_QUEUED_FRAMES + 1)).then((record) => expect(record.offset).toBe(MAX_QUEUED_FRAMES * FRAME.length));
    expect(spool.index.frames).toHaveLength(MAX_QUEUED_FRAMES + 1);

    const oversized = Buffer.alloc(MAX_QUEUED_BYTES + 1, 3);
    await expect(spool.append(oversized, frameMeta(99))).rejects.toThrow(/queue cap exceeded/);
    await expect(spool.append(FRAME, frameMeta(MAX_QUEUED_FRAMES + 2))).resolves.toMatchObject({ offset: (MAX_QUEUED_FRAMES + 1) * FRAME.length });
    await spool.close();
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
