import { createWriteStream, promises as fs } from "node:fs";
import { join } from "node:path";
import type { ViewportSpec } from "@hoolypane/contracts";
import { MAX_QUEUED_BYTES, MAX_QUEUED_FRAMES, timestampSecondsToUs, type SourceFrame } from "./capture-contract.js";

export interface ScreencastFrame {
  readonly data: string;
  readonly sessionId?: number;
  readonly metadata?: { readonly timestamp?: number; readonly frameSequence?: number; readonly deviceWidth?: number; readonly deviceHeight?: number };
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

  constructor(readonly viewportId: string, readonly directory: string) {
    this.index = { viewportId, frames: [], bytes: 0, maxQueuedFrames: 0, maxQueuedBytes: 0 };
  }

  async open(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    this.stream = createWriteStream(join(this.directory, `${this.viewportId}.jpeg.bin`), { flags: "a" });
  }

  append(data: Buffer, frame: Omit<SourceFrame, "offset" | "length">): Promise<SourceFrame> {
    if (this.closed || !this.stream) return Promise.reject(new Error("frame spool is not open"));
    if (this.queuedFrames + 1 > MAX_QUEUED_FRAMES || this.queuedBytes + data.length > MAX_QUEUED_BYTES) {
      return Promise.reject(new Error(`capture queue cap exceeded for ${this.viewportId}`));
    }
    this.queuedFrames += 1;
    this.queuedBytes += data.length;
    this.index.maxQueuedFrames = Math.max(this.index.maxQueuedFrames, this.queuedFrames);
    this.index.maxQueuedBytes = Math.max(this.index.maxQueuedBytes, this.queuedBytes);
    const record: SourceFrame = { ...frame, offset: this.nextOffset, length: data.length };
    this.nextOffset += data.length;
    const completion = Promise.withResolvers<void>();
    this.writeChain = this.writeChain.then(() => {
      this.stream!.write(data, (error: Error | null | undefined) => error ? completion.reject(error) : completion.resolve());
      return completion.promise;
    }).then(() => {
      this.index.frames.push(record);
      this.index.bytes += data.length;
    }).finally(() => {
      this.queuedFrames -= 1;
      this.queuedBytes -= data.length;
    });
    return this.writeChain.then(() => record);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writeChain;
    const stream = this.stream;
    if (!stream) return;
    const completion = Promise.withResolvers<void>();
    stream.end((error: Error | null | undefined) => error ? completion.reject(error) : completion.resolve());
    await completion.promise;
    await fs.writeFile(join(this.directory, `${this.viewportId}.index.json`), JSON.stringify(this.index));
  }

  async read(frame: SourceFrame): Promise<Buffer> {
    const handle = await fs.open(join(this.directory, `${this.viewportId}.jpeg.bin`), "r");
    try {
      const data = Buffer.allocUnsafe(frame.length);
      await handle.read(data, 0, frame.length, frame.offset);
      return data;
    } finally {
      await handle.close();
    }
  }
}

export class CaptureSpool {
  readonly spools = new Map<string, FrameSpool>();

  async create(targets: readonly CaptureTarget[], directory: string): Promise<void> {
    await Promise.all(targets.map(async (target) => {
      const spool = new FrameSpool(target.id, directory);
      await spool.open();
      this.spools.set(target.id, spool);
    }));
  }

  async close(): Promise<void> {
    await Promise.all([...this.spools.values()].map((spool) => spool.close()));
  }
}

export function decodeScreencastData(frame: ScreencastFrame): Buffer {
  if (typeof frame.data !== "string" || !frame.data) throw new Error("screencast frame has no JPEG data");
  return Buffer.from(frame.data, "base64");
}

export function frameMetadata(frame: ScreencastFrame, sequence: number): Omit<SourceFrame, "offset" | "length"> {
  const metadata = frame.metadata;
  return {
    sequence: metadata?.frameSequence ?? sequence,
    width: metadata?.deviceWidth ?? 0,
    height: metadata?.deviceHeight ?? 0,
    timestampUs: timestampSecondsToUs(metadata?.timestamp),
  };
}
