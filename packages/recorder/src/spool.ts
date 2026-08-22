import { createWriteStream, promises as fs } from "node:fs";
import { join } from "node:path";
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
  maxQueuedFrames: number;
  maxQueuedBytes: number;
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
  private stream: ReturnType<typeof createWriteStream> | undefined;
  private queuedFrames = 0;
  private queuedBytes = 0;
  private nextOffset = 0;
  private writeChain = Promise.resolve();
  private closed = false;
  private failure: Error | undefined;

  constructor(readonly viewportId: string, readonly directory: string) {
    this.index = { viewportId, frames: [], bytes: 0, maxQueuedFrames: 0, maxQueuedBytes: 0 };
  }

  async open(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    const stream = createWriteStream(join(this.directory, `${this.viewportId}.jpeg.bin`), { flags: "w" });
    stream.on("error", (error) => { this.failure ??= error instanceof Error ? error : new Error(String(error)); });
    this.stream = stream;
  }

  append(data: Buffer, frame: Omit<SourceFrame, "offset" | "length">): Promise<SourceFrame> {
    if (this.closed || !this.stream) return Promise.reject(new Error("frame spool is not open"));
    if (this.failure) return Promise.reject(this.failure);
    if (this.queuedFrames + 1 > MAX_QUEUED_FRAMES || this.queuedBytes + data.length > MAX_QUEUED_BYTES) {
      return Promise.reject(new Error(`capture queue cap exceeded for ${this.viewportId}`));
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
    await fs.writeFile(join(this.directory, `${this.viewportId}.index.json`), JSON.stringify(this.index));
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

  async close(): Promise<void> {
    const settled = await Promise.allSettled([...this.spools.values()].map((spool) => spool.close()));
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
