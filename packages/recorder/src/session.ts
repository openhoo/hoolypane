import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, relative } from "node:path";
import { hrtime } from "node:process";
import type { ResolvedRecordingConfig, ViewportSpec, FlowEvent } from "@hoolypane/contracts";
import { encodedDimension } from "@hoolypane/contracts";
import {
  alignFrames,
  assertStateTransition,
  CAPTURE_CONTRACT,
  durationFrameCount,
  geometryForViewport,
  POST_ROLL_US,
  VALIDATOR_VERSION,
  type CompositeGeometry,
  type RecordingState,
  type SlotMapping,
} from "./capture-contract.js";
import { encodeAligned } from "./encoder.js";
import { CaptureSpool, decodeScreencastData, frameMetadata, writeFileAtomic, type CaptureTarget, type FrameSpool, type ScreencastFrame } from "./spool.js";
import { verifyArtifacts } from "./verifier.js";

export interface RecorderFailure { readonly message: string; readonly viewportId?: string; readonly stepId?: string; readonly stack?: string }
export type RecordingTarget = CaptureTarget;
type RecordingFinalizeResult = { readonly kind: "manifest"; readonly manifestPath: string; readonly manifest: RecordingManifest } | { readonly kind: "diagnostics"; readonly diagnosticsPath: string };

interface RecordingManifest {
  readonly contract: typeof CAPTURE_CONTRACT;
  readonly validatorVersion: number;
  readonly validationSuccess: true;
  readonly status: "success" | "failed" | "interrupted";
  readonly runId: string;
  readonly t0UnixUs: number;
  readonly t1UnixUs: number;
  readonly fps: 30 | 60;
  readonly durationFrames: number;
  readonly codec: "vp8";
  readonly geometry: CompositeGeometry;
  readonly viewports: readonly {
    id: string;
    viewport: ViewportSpec;
    sourceWidth: number;
    sourceHeight: number;
    encodedWidth: number;
    encodedHeight: number;
    heldFrames: number;
    maximumSelectedSourceSkewUs: number;
    queue: { maxFrames: number; maxBytes: number };
  }[];
  readonly mappings: Readonly<Record<string, readonly SlotMapping[]>>;
  readonly failures: readonly RecorderFailure[];
  readonly flowEvents: readonly FlowEvent[];
  readonly artifacts: Readonly<Record<string, string>>;
  readonly sha256: Readonly<Record<string, string>>;
}

interface Context {
  readonly target: RecordingTarget;
  readonly spool: FrameSpool;
  readonly listener: (event: unknown) => void;
  initialTimestampUs?: number;
  captureError?: Error;
  fallbackSequence: number;
}

function monotonicUs(): number {
  return Number(hrtime.bigint() / 1000n);
}

function delay(milliseconds: number): Promise<void> {
  const completion = Promise.withResolvers<void>();
  setTimeout(completion.resolve, milliseconds);
  return completion.promise;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function sha256(path: string): Promise<string> {
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
async function collectDirectoryArtifacts(outputDir: string, directoryName: string, artifacts: Record<string, string>, hashes: Record<string, string>): Promise<void> {
  const directory = join(outputDir, directoryName);
  let names: string[];
  try { names = await fs.readdir(directory); } catch { return; }
  for (const name of names) {
    const path = join(directory, name);
    try {
      const metadata = await fs.stat(path);
      if (!metadata.isFile()) continue;
      const key = relative(outputDir, path);
      hashes[key] = await sha256(path);
      artifacts[key] = key;
    } catch { continue; }
  }
}

export class RecordingSession {
  private state: RecordingState = "awaiting-initial-frames";
  private readonly spools = new CaptureSpool();
  private readonly contexts: Context[] = [];
  private readonly captureCloseFailures: RecorderFailure[] = [];
  private started = false;
  private finalized = false;
  private captureStopped = false;
  private t0Us: number | undefined;
  private flowStartUs: number | undefined;
  private runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  constructor(private readonly options: { readonly recording: Omit<ResolvedRecordingConfig, "outputDir">; readonly timeoutMs: number; readonly outputDir: string }) {}


  private async transition(next: RecordingState): Promise<void> {
    assertStateTransition(this.state, next);
    this.state = next;
    await atomicJson(join(this.options.outputDir, "run-state.json"), { runId: this.runId, state: this.state, contract: this.t0Us === undefined ? null : CAPTURE_CONTRACT });
  }

  async start(targets: readonly RecordingTarget[]): Promise<void> {
    if (this.started) throw new Error("recording session already started");
    if (targets.length === 0) throw new Error("recording requires at least one target");
    this.started = true;
    await fs.mkdir(this.options.outputDir, { recursive: true });
    // A rerun into the same outputDir must never inherit artifacts from a previous run.
    await Promise.all([
      ...["videos", "traces", "raw"].map((entry) => fs.rm(join(this.options.outputDir, entry), { recursive: true, force: true })),
      ...["manifest.json", "diagnostics.json", "run-state.json"].map((file) => fs.rm(join(this.options.outputDir, file), { force: true })),
    ]);
    await this.spools.create(targets, join(this.options.outputDir, "raw"));
    try {
      // Inside the guard: a failing initial state write must dispose the opened spools.
      await atomicJson(join(this.options.outputDir, "run-state.json"), { runId: this.runId, state: this.state, contract: null });
      for (const target of targets) {
        const spool = this.spools.spools.get(target.id)!;
        let context: Context;
        const listener = (event: unknown) => { void this.receive(context, event as ScreencastFrame); };
        context = { target, spool, listener, fallbackSequence: 0 };
        this.contexts.push(context);
        target.on("Page.screencastFrame", listener);
        const geometry = geometryForViewport(target.viewport);
        await target.send("Page.startScreencast", {
          format: "jpeg",
          quality: this.options.recording.jpegQuality,
          maxWidth: geometry.encodedWidth,
          maxHeight: geometry.encodedHeight,
          everyNthFrame: 1,
        });
      }
    } catch (error) {
      await Promise.allSettled(this.contexts.map((context) => context.target.send("Page.stopScreencast")));
      for (const context of this.contexts) context.target.off("Page.screencastFrame", context.listener);
      await this.spools.close().catch(() => undefined);
      throw error;
    }
  }

  private async receive(context: Context, frame: ScreencastFrame): Promise<void> {
    if (context.captureError) return;
    try {
      const data = decodeScreencastData(frame);
      const metadata = frameMetadata(frame, context.fallbackSequence++);
      const viewport = context.target.viewport;
      const maximumWidth = encodedDimension(viewport.width, viewport.deviceScaleFactor);
      const maximumHeight = encodedDimension(viewport.height, viewport.deviceScaleFactor);
      if (metadata.width <= 0 || metadata.height <= 0 || metadata.width > maximumWidth || metadata.height > maximumHeight) {
        throw new Error(`unexpected source geometry ${metadata.width}x${metadata.height} for ${context.target.id}, maximum ${maximumWidth}x${maximumHeight}`);
      }
      const first = context.spool.index.frames[0];
      if (first && (first.width !== metadata.width || first.height !== metadata.height)) throw new Error(`source geometry changed for ${context.target.id}`);
      await context.spool.append(data, metadata);
      context.initialTimestampUs ??= metadata.timestampUs;
      if (frame.sessionId === undefined) throw new Error(`screencast frame for ${context.target.id} has no session id`);
      await context.target.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
    } catch (error) {
      context.captureError = error instanceof Error ? error : new Error(String(error));
    }
  }

  async awaitInitialFrames(signal?: AbortSignal): Promise<void> {
    if (!this.started) throw new Error("start must be called first");
    const deadline = Date.now() + this.options.timeoutMs;
    while (
      this.state === "awaiting-initial-frames" &&
      signal?.aborted !== true &&
      this.contexts.some((context) => context.initialTimestampUs === undefined && context.captureError === undefined) &&
      Date.now() < deadline
    ) await delay(10);
    if (this.state !== "awaiting-initial-frames") throw new Error("recording session was finalized while waiting for initial frames");
    if (signal?.aborted) throw new Error("waiting for initial screencast frames was aborted");
    const failure = this.contexts.find((context) => context.captureError)?.captureError;
    if (failure || this.contexts.some((context) => context.initialTimestampUs === undefined)) {
      await this.transition("failed");
      throw failure ?? new Error("timed out waiting for initial screencast frames");
    }
    this.t0Us = Math.max(...this.contexts.map((context) => context.initialTimestampUs!));
    await this.transition("recording");
  }

  markFlowStart(): void {
    if (this.state !== "recording" || this.t0Us === undefined) throw new Error("initial frames must be ready before flow start");
    this.flowStartUs = monotonicUs();
  }

  private async stopCapture(): Promise<void> {
    if (this.captureStopped) return;
    this.captureStopped = true;
    await Promise.allSettled(this.contexts.map((context) => context.target.send("Page.stopScreencast")));
    for (const context of this.contexts) context.target.off("Page.screencastFrame", context.listener);
    await this.spools.close((viewportId, error) => {
      this.captureCloseFailures.push({ message: `capture spool close failed: ${error.message}`, viewportId });
    }).catch(() => undefined);
  }

  /** keepRaw=false: raw bins never survive any exit path. */
  private async pruneRawBins(): Promise<void> {
    if (this.options.recording.keepRaw) return;
    await fs.rm(join(this.options.outputDir, "raw"), { recursive: true, force: true }).catch(() => undefined);
  }

  /** Failed exits additionally discard partially encoded videos; success keeps every artifact the manifest certifies. */
  private async pruneFailedArtifacts(): Promise<void> {
    await Promise.allSettled([this.pruneRawBins(), fs.rm(join(this.options.outputDir, "videos"), { recursive: true, force: true })]);
  }

  private async cancellableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    const completion = Promise.withResolvers<void>();
    const timer = setTimeout(completion.resolve, milliseconds);
    const onAbort = () => completion.reject(signal!.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await completion.promise;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async finalize(input: { readonly status: "success" | "failed" | "interrupted"; readonly failures: readonly RecorderFailure[]; readonly events?: readonly FlowEvent[]; readonly signal?: AbortSignal }): Promise<RecordingFinalizeResult> {
    if (this.finalized) throw new Error("recording session already finalized");
    this.finalized = true;
    try {
      if (this.t0Us === undefined) {
        await fs.mkdir(this.options.outputDir, { recursive: true });
        if (this.state !== "failed") await this.transition("failed");
        await this.stopCapture();
        const spoolNotes = this.contexts.flatMap((context) => [...context.spool.drainFailureNotes()]);
        const diagnosticsPath = join(this.options.outputDir, "diagnostics.json");
        await atomicJson(diagnosticsPath, { contract: null, status: input.status, failures: [...input.failures, ...spoolNotes, ...this.captureCloseFailures] });
        await this.pruneFailedArtifacts();
        return { kind: "diagnostics", diagnosticsPath };
      }
      let manifestWritten = false;
      try {
        const elapsedUs = Math.max(0, monotonicUs() - (this.flowStartUs ?? monotonicUs()));
        await this.transition("post-roll");
        await this.cancellableDelay(POST_ROLL_US / 1000, input.signal);
        const t1Us = this.t0Us + elapsedUs + POST_ROLL_US;
        await this.transition("stopping");
        await this.stopCapture();
        input.signal?.throwIfAborted();
        await this.transition("aligning");
        const durationFrames = durationFrameCount(this.t0Us, t1Us, this.options.recording.fps);
        const captureFailures = [
          ...this.contexts
            .filter((context) => context.captureError)
            .map((context) => ({ message: `capture ended early: ${context.captureError!.message}`, viewportId: context.target.id })),
          ...this.captureCloseFailures,
        ];
        const spoolFailureNotes = this.contexts.flatMap((context) => [...context.spool.drainFailureNotes()]);
        const mappings: Record<string, readonly SlotMapping[]> = {};
        const aligned = this.contexts.map((context) => {
          const result = alignFrames(context.spool.index.frames, this.t0Us!, durationFrames, this.options.recording.fps);
          mappings[context.target.id] = result.mappings;
          return { context, result, geometry: geometryForViewport(context.target.viewport) };
        });
        await this.transition("encoding");
        const encoding = await encodeAligned(
          this.options.outputDir,
          aligned.map(({ context, result, geometry }) => ({ id: context.target.id, spool: context.spool, mappings: result.mappings, geometry })),
          this.options.recording.fps,
          durationFrames,
          this.options.recording,
        );
        await this.transition("validating");
        const verification = await verifyArtifacts(this.options.outputDir, this.options.recording.fps, durationFrames, {
          tracks: aligned.map(({ context, geometry }) => ({ id: context.target.id, encodedWidth: geometry.encodedWidth, encodedHeight: geometry.encodedHeight })),
          composite: { width: encoding.geometry.outputWidth, height: encoding.geometry.outputHeight },
        });
        if (!verification.success) {
          await this.transition("failed");
          throw new Error(`artifact validation failed: ${verification.error ?? "unknown error"}`);
        }
        const artifacts = { ...verification.artifacts };
        const hashes = { ...verification.sha256 };
        await collectDirectoryArtifacts(this.options.outputDir, "traces", artifacts, hashes);
        if (this.options.recording.keepRaw) await collectDirectoryArtifacts(this.options.outputDir, "raw", artifacts, hashes);
        const manifest: RecordingManifest = {
          contract: CAPTURE_CONTRACT,
          validatorVersion: VALIDATOR_VERSION,
          validationSuccess: true,
          status: captureFailures.length > 0 ? "failed" : input.status,
          runId: this.runId,
          t0UnixUs: this.t0Us,
          t1UnixUs: t1Us,
          fps: this.options.recording.fps,
          durationFrames,
          codec: "vp8",
          geometry: encoding.geometry,
          viewports: aligned.map(({ context, result, geometry }) => {
            const first = context.spool.index.frames[0]!;
            return {
              id: context.target.id,
              viewport: context.target.viewport,
              sourceWidth: first.width,
              sourceHeight: first.height,
              encodedWidth: geometry.encodedWidth,
              encodedHeight: geometry.encodedHeight,
              heldFrames: result.heldFrames,
              maximumSelectedSourceSkewUs: result.maximumSkewUs,
              queue: { maxFrames: context.spool.index.maxQueuedFrames, maxBytes: context.spool.index.maxQueuedBytes },
            };
          }),
          mappings,
          failures: [...input.failures, ...spoolFailureNotes, ...captureFailures],
          flowEvents: input.events ?? [],
          artifacts,
          sha256: hashes,
        };
        const manifestPath = join(this.options.outputDir, "manifest.json");
        const statePath = join(this.options.outputDir, "run-state.json");
        const stateKey = relative(this.options.outputDir, statePath);
        // The terminal run-state write follows the manifest write: if the manifest fails to land,
        // the catch guard must still be able to mark the run failed instead of leaving a permanent
        // false "complete" record behind (see pruneFailedArtifacts contract). The manifest certifies
        // run-state.json, so hash the exact bytes transition("complete") persists below.
        const finalManifest = { ...manifest, artifacts: { ...manifest.artifacts, "run-state.json": stateKey }, sha256: { ...manifest.sha256, [stateKey]: createHash("sha256").update(`${JSON.stringify({ runId: this.runId, state: "complete", contract: CAPTURE_CONTRACT }, null, 2)}\n`).digest("hex") } };
        await this.pruneRawBins();
        await atomicJson(manifestPath, finalManifest);
        await this.transition("complete");
        manifestWritten = true;
        return { kind: "manifest", manifestPath, manifest: finalManifest };
      } catch (error) {
        try {
          if (this.state !== "complete" && this.state !== "failed") await this.transition("failed");
        } catch { /* the original error takes precedence */ }
        try {
          const message = error instanceof Error ? error.message : String(error);
          await atomicJson(join(this.options.outputDir, "diagnostics.json"), { contract: CAPTURE_CONTRACT, status: input.status, failures: [...input.failures, { message: `finalize pipeline failed: ${message}` }] });
        } catch { /* the original error takes precedence */ }
        if (!manifestWritten) await this.pruneFailedArtifacts();
        throw error;
      }
    } finally {
      try {
        await this.stopCapture();
      } catch { /* cleanup errors must not mask the original failure */ }
    }
  }
}
