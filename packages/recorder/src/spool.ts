import { randomBytes } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";
import type { ViewportSpec } from "@hoolypane/contracts";
import { MAX_QUEUED_BYTES, MAX_QUEUED_FRAMES, timestampSecondsToUs, type SourceFrame } from "./capture-contract.js";

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

interface SpoolFailureNote { readonly message: string; readonly viewportId?: string }

const ARTIFACT_MODE = 0o600;
const DROP_NOTE_INTERVAL_MS = 1_000;

/** Best-effort fsync of the parent directory so a completed rename survives power loss. */
async function syncParentDirectory(path: string): Promise<void> {
  try {
    const handle = await fs.open(dirname(path), "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch { /* directory fsync is unsupported on some platforms */ }
}

/** Writes `data` durably: temp file (0o600) -> fsync -> rename -> parent-dir fsync. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await fs.open(temporary, "wx", ARTIFACT_MODE);
  try {
    await handle.writeFile(data);
    await handle.sync();
    await fs.rename(temporary, path);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
  await syncParentDirectory(path);
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
  private queuedFrames = 0;
  private queuedBytes = 0;
  private nextOffset = 0;
  private writeChain = Promise.resolve();
  private closed = false;
  private failure: Error | undefined;
  private failureNotes: SpoolFailureNote[] = [];
  private lastDropNoteAt = 0;
  private notedDrops = 0;

  constructor(readonly viewportId: string, readonly directory: string) {
    this.index = { viewportId, frames: [], bytes: 0, droppedFrames: 0, maxQueuedFrames: 0, maxQueuedBytes: 0 };
  }

  async open(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    const stream = createWriteStream(join(this.directory, `${this.viewportId}.jpeg.bin`), { flags: "w", mode: ARTIFACT_MODE });
    stream.on("error", (error) => { this.failure ??= error instanceof Error ? error : new Error(String(error)); });
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
          if (error) this.failure ??= error instanceof Error ? error : new Error(String(error));
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
        this.failure ??= error instanceof Error ? error : new Error(String(error));
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
  drainFailureNotes(): readonly SpoolFailureNote[] {
    return this.failureNotes.splice(0);
  }

  async close(): Promise<void> {
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
      this.failure ??= error instanceof Error ? error : new Error(String(error));
    }
    if (this.index.droppedFrames > this.notedDrops) {
      this.failureNotes.push({ message: `capture queue saturated for ${this.viewportId}: dropped ${this.index.droppedFrames} over-cap frame(s) in total`, viewportId: this.viewportId });
      this.notedDrops = this.index.droppedFrames;
    }
    await writeFileAtomic(join(this.directory, `${this.viewportId}.index.json`), JSON.stringify(this.index));
    if (this.failure) throw this.failure;
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writeChain.catch(() => undefined);
    const stream = this.stream;
    this.stream = undefined;
    stream?.destroy();
  }

  async read(frame: SourceFrame): Promise<Buffer> {
    const handle = await fs.open(join(this.directory, `${this.viewportId}.jpeg.bin`), "r");
    try {
      const data = Buffer.allocUnsafe(frame.length);
      const { bytesRead } = await handle.read(data, 0, frame.length, frame.offset);
      if (bytesRead !== frame.length) throw new Error(`frame truncated for ${this.viewportId}: read ${bytesRead} of ${frame.length} bytes at offset ${frame.offset}`);
      return data;
    } finally {
      await handle.close();
    }
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
        onFailure?.(spool.viewportId, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    }));
    const failure = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected")?.reason;
    if (failure !== undefined) throw failure instanceof Error ? failure : new Error(String(failure));
  }
}

export function decodeScreencastData(frame: ScreencastFrame): Buffer {
  const data = Buffer.from(frame.data, "base64");
  if (data.length === 0) throw new Error("screencast frame has no JPEG data");
  return data;
}

export function frameMetadata(frame: ScreencastFrame, sequence: number): Omit<SourceFrame, "offset" | "length"> {
  const metadata = frame.metadata;
  return {
    sequence,
    width: metadata?.deviceWidth ?? 0,
    height: metadata?.deviceHeight ?? 0,
    timestampUs: timestampSecondsToUs(metadata?.timestamp),
  };
}
