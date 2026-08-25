import { createHash } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Writable } from "node:stream";
import type { ViewportSpec } from "@hoolypane/contracts";
import { writeFileAtomic } from "@hoolypane/contracts/fsync";
import { asError, MAX_QUEUED_BYTES, MAX_QUEUED_FRAMES, timestampSecondsToUs, type RecorderFailure, type SourceFrame } from "./capture-contract.js";

export interface ScreencastFrame {
  readonly data: string;
  readonly sessionId?: number;
  readonly metadata?: { readonly timestamp?: number; readonly deviceWidth?: number; readonly deviceHeight?: number };
}

interface SpoolIndex {
  readonly viewportId: string;
  readonly frames: SourceFrame[];
  bytes: number;
  droppedFrames: number;
  maxQueuedFrames: number;
  maxQueuedBytes: number;
}

const ARTIFACT_MODE = 0o600;
const DROP_NOTE_INTERVAL_MS = 1_000;

/** Durable atomic write (temp sibling 0o600 -> fsync -> rename -> parent-dir fsync), single-sourced in contracts' node-only fsync subpath. */
export { writeFileAtomic };

async function sha256File(path: string): Promise<string> {
  const handle = await fs.open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

/** Certifies one artifact file into the manifest key/hash maps under the shared `<directory>/<name>` key scheme. */
export async function certifyArtifact(outputDir: string, directoryName: string, name: string, artifacts: Record<string, string>, hashes: Record<string, string>): Promise<void> {
  const path = join(outputDir, directoryName, name);
  const metadata = await fs.stat(path);
  if (!metadata.isFile()) return;
  const key = relative(outputDir, path);
  hashes[key] = await sha256File(path);
  artifacts[key] = key;
}

/** Best-effort collection: missing directories and unreadable entries are skipped instead of failing the manifest. */
export async function collectDirectoryArtifacts(outputDir: string, directoryName: string, artifacts: Record<string, string>, hashes: Record<string, string>, filter?: (name: string) => boolean): Promise<void> {
  let names: string[];
  try { names = await fs.readdir(join(outputDir, directoryName)); } catch { return; }
  for (const name of names) {
    if (filter && !filter(name)) continue;
    try {
      await certifyArtifact(outputDir, directoryName, name, artifacts, hashes);
    } catch { continue; }
  }
}

export interface CaptureTarget {
  readonly id: string;
  readonly viewport: ViewportSpec;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (params: unknown) => void): void;
  off(event: string, listener: (params: unknown) => void): void;
}

export class FrameSpool {
  readonly index: SpoolIndex;
  private stream: Writable | undefined;
  private readHandle: FileHandle | undefined;
  private queuedFrames = 0;
  private queuedBytes = 0;
  private nextOffset = 0;
  private writeChain = Promise.resolve();
  private closed = false;
  private failure: Error | undefined;
  private failureNotes: RecorderFailure[] = [];
  private lastDropNoteAt = 0;
  private notedDrops = 0;

  constructor(readonly viewportId: string, readonly directory: string) {
    this.index = { viewportId, frames: [], bytes: 0, droppedFrames: 0, maxQueuedFrames: 0, maxQueuedBytes: 0 };
  }

  async open(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    const stream = createWriteStream(join(this.directory, `${this.viewportId}.jpeg.bin`), { flags: "w", mode: ARTIFACT_MODE });
    stream.on("error", (error) => { this.failure ??= asError(error); });
    this.stream = stream;
  }

  append(data: Buffer, frame: Omit<SourceFrame, "offset" | "length">): Promise<SourceFrame> {
    if (this.closed || !this.stream) return Promise.reject(new Error("frame spool is not open"));
    if (this.failure) return Promise.reject(this.failure);
    // The byte cap is hard backpressure: accepting would balloon memory, so it still rejects.
    if (this.queuedBytes + data.length > MAX_QUEUED_BYTES) {
      return Promise.reject(new Error(`capture queue cap exceeded for ${this.viewportId}`));
    }
    // Frame-count saturation drops the frame instead of failing capture: append still
    // resolves so the upstream screencast ack proceeds; the loss is counted and surfaced
    // as a throttled non-fatal note.
    if (this.queuedFrames + 1 > MAX_QUEUED_FRAMES) {
      this.index.droppedFrames += 1;
      const now = Date.now();
      if (now - this.lastDropNoteAt >= DROP_NOTE_INTERVAL_MS) {
        this.lastDropNoteAt = now;
        this.notedDrops = this.index.droppedFrames;
        this.failureNotes.push({ message: `capture queue saturated for ${this.viewportId}: dropped ${this.notedDrops} over-cap frame(s)`, viewportId: this.viewportId });
      }
      return Promise.resolve({ ...frame, offset: this.nextOffset, length: 0 });
    }
    this.queuedFrames += 1;
    this.queuedBytes += data.length;
    this.index.maxQueuedFrames = Math.max(this.index.maxQueuedFrames, this.queuedFrames);
    this.index.maxQueuedBytes = Math.max(this.index.maxQueuedBytes, this.queuedBytes);
    const record: SourceFrame = { ...frame, offset: this.nextOffset, length: data.length };
    this.nextOffset += data.length;
    const completion = Promise.withResolvers<SourceFrame>();
    this.writeChain = this.writeChain
      .then(() => new Promise<void>((resolve) => {
        this.stream!.write(data, (error) => {
          if (error) this.failure ??= asError(error);
          resolve();
        });
      }))
      .then(() => {
        if (!this.failure) {
          this.index.frames.push(record);
          this.index.bytes += data.length;
        }
      })
      .catch((error: unknown) => {
        this.failure ??= asError(error);
      })
      .then(() => {
        if (this.failure) completion.reject(this.failure);
        else completion.resolve(record);
      })
      .finally(() => {
        this.queuedFrames -= 1;
        this.queuedBytes -= data.length;
      })
      .catch(() => undefined);
    return completion.promise;
  }

  /** Pops accumulated non-fatal failure notes (drop tallies); consumed by the session manifest. */
  drainFailureNotes(): readonly RecorderFailure[] {
    return this.failureNotes.splice(0);
  }

  async close(): Promise<void> {
    await this.closeRead();
    if (this.closed) return;
    this.closed = true;
    await this.writeChain;
    const stream = this.stream;
    if (!stream) return;
    const completion = Promise.withResolvers<void>();
    stream.end((error: Error | null | undefined) => error ? completion.reject(error) : completion.resolve());
    try {
      await completion.promise;
    } catch {
      /* write errors already surface via the append failure state */
    }
    const binPath = join(this.directory, `${this.viewportId}.jpeg.bin`);
    try {
      const handle = await fs.open(binPath, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      this.failure ??= asError(error);
    }
    if (this.index.droppedFrames > this.notedDrops) {
      this.failureNotes.push({ message: `capture queue saturated for ${this.viewportId}: dropped ${this.index.droppedFrames} over-cap frame(s) in total`, viewportId: this.viewportId });
      this.notedDrops = this.index.droppedFrames;
    }
    await writeFileAtomic(join(this.directory, `${this.viewportId}.index.json`), JSON.stringify(this.index));
    if (this.failure) throw this.failure;
  }

  async dispose(): Promise<void> {
    await this.closeRead();
    if (this.closed) return;
    this.closed = true;
    await this.writeChain.catch(() => undefined);
    const stream = this.stream;
    this.stream = undefined;
    stream?.destroy();
  }

  /** Reads always target the immutable finalized bin, so one cached handle serves the whole encode loop. */
  async read(frame: SourceFrame): Promise<Buffer> {
    const handle = this.readHandle ??= await fs.open(join(this.directory, `${this.viewportId}.jpeg.bin`), "r");
    try {
      const data = Buffer.allocUnsafe(frame.length);
      const { bytesRead } = await handle.read(data, 0, frame.length, frame.offset);
      if (bytesRead !== frame.length) throw new Error(`frame truncated for ${this.viewportId}: read ${bytesRead} of ${frame.length} bytes at offset ${frame.offset}`);
      return data;
    } catch (error) {
      // A failed handle must not poison later reads: drop the cache entry so the next read reopens.
      this.readHandle = undefined;
      await handle.close().catch(() => undefined);
      throw error;
    }
  }
  /** Closes the cached read handle; safe to call any time, including before or after close()/dispose(). */
  async closeRead(): Promise<void> {
    const readHandle = this.readHandle;
    this.readHandle = undefined;
    if (readHandle) await readHandle.close().catch(() => undefined);
  }
}

export class CaptureSpool {
  readonly spools = new Map<string, FrameSpool>();

  async create(targets: readonly CaptureTarget[], directory: string): Promise<void> {
    const opened: FrameSpool[] = [];
    try {
      for (const target of targets) {
        if (this.spools.has(target.id)) throw new Error(`duplicate capture target id: ${target.id}`);
        const spool = new FrameSpool(target.id, directory);
        await spool.open();
        this.spools.set(target.id, spool);
        opened.push(spool);
      }
    } catch (error) {
      await Promise.allSettled(opened.map((spool) => spool.dispose()));
      for (const spool of opened) this.spools.delete(spool.viewportId);
      throw error;
    }
  }

  async close(onFailure?: (viewportId: string, error: Error) => void): Promise<void> {
    const settled = await Promise.allSettled([...this.spools.values()].map(async (spool) => {
      try {
        await spool.close();
      } catch (error) {
        onFailure?.(spool.viewportId, asError(error));
        throw error;
      }
    }));
    const failure = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected")?.reason;
    if (failure !== undefined) throw asError(failure);
  }
}

export function decodeScreencastData(frame: ScreencastFrame): Buffer {
  const data = Buffer.from(frame.data, "base64");
  if (data.length === 0) throw new Error("screencast frame has no JPEG data");
  return data;
}

export function frameMetadata(frame: ScreencastFrame, sequence: number): Omit<SourceFrame, "offset" | "length"> {
  const metadata = frame.metadata;
  if (metadata?.deviceWidth === undefined || metadata.deviceHeight === undefined) throw new Error("screencast frame is missing valid device metrics");
  return {
    sequence,
    width: metadata.deviceWidth,
    height: metadata.deviceHeight,
    timestampUs: timestampSecondsToUs(metadata.timestamp),
  };
}
