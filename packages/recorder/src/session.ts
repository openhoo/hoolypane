import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, relative } from "node:path";
import { hrtime } from "node:process";
import type { ResolvedRecordingConfig, ViewportSpec } from "@hoolypane/contracts";
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
import { CaptureSpool, decodeScreencastData, frameMetadata, type CaptureTarget, type FrameSpool, type ScreencastFrame } from "./spool.js";
import { verifyArtifacts } from "./verifier.js";

export interface RecorderFailure { readonly message: string; readonly viewportId?: string; readonly stepId?: string; readonly stack?: string }
export interface RecorderFlowEvent { readonly label: string; readonly phase: "start" | "complete" | "failed"; readonly atUnixMs: number }
export type RecordingTarget = CaptureTarget;
export type RecordingFinalizeResult = { readonly kind: "manifest"; readonly manifestPath: string; readonly manifest: RecordingManifest } | { readonly kind: "diagnostics"; readonly diagnosticsPath: string };

export interface RecordingManifest {
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
  readonly flowEvents: readonly RecorderFlowEvent[];
  readonly artifacts: Readonly<Record<string, string>>;
  readonly sha256: Readonly<Record<string, string>>;
}

interface Context {
  readonly target: RecordingTarget;
  readonly spool: FrameSpool;
  readonly listener: (event: unknown) => void;
  initialTimestampUs?: number;
  captureError?: Error;
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
  const temporary = `${path}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, path);
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(path)).digest("hex");
}
async function collectDirectoryArtifacts(outputDir: string, directoryName: string, artifacts: Record<string, string>, hashes: Record<string, string>): Promise<void> {
  const directory = join(outputDir, directoryName);
  let names: string[];
  try { names = await fs.readdir(directory); } catch { return; }
  for (const name of names) {
    const path = join(directory, name);
    const metadata = await fs.stat(path);
    if (!metadata.isFile()) continue;
    const key = relative(outputDir, path);
    artifacts[key] = key;
    hashes[key] = await sha256(path);
  }
}

export class RecordingSession {
  private state: RecordingState = "awaiting-initial-frames";
  private readonly spools = new CaptureSpool();
  private readonly contexts: Context[] = [];
  private started = false;
  private finalized = false;
  private t0Us: number | undefined;
  private flowStartUs: number | undefined;
  private runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  constructor(private readonly options: { readonly recording: ResolvedRecordingConfig; readonly timeoutMs: number; readonly outputDir: string }) {}

  get currentState(): RecordingState { return this.state; }
  get t0(): number | undefined { return this.t0Us; }

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
    await this.spools.create(targets, join(this.options.outputDir, "raw"));
    await atomicJson(join(this.options.outputDir, "run-state.json"), { runId: this.runId, state: this.state, contract: null });
    for (const target of targets) {
      const spool = this.spools.spools.get(target.id)!;
      let context: Context;
      const listener = (event: unknown) => { void this.receive(context, event as ScreencastFrame); };
      context = { target, spool, listener };
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
  }

  private async receive(context: Context, frame: ScreencastFrame): Promise<void> {
    if (context.captureError) return;
    try {
      const data = decodeScreencastData(frame);
      const metadata = frameMetadata(frame, context.spool.index.frames.length);
      const viewport = context.target.viewport;
      const maximumWidth = 2 * Math.ceil(viewport.width * viewport.deviceScaleFactor / 2);
      const maximumHeight = 2 * Math.ceil(viewport.height * viewport.deviceScaleFactor / 2);
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

  async awaitInitialFrames(): Promise<void> {
    if (!this.started) throw new Error("start must be called first");
    const deadline = Date.now() + this.options.timeoutMs;
    while (this.contexts.some((context) => context.initialTimestampUs === undefined && context.captureError === undefined) && Date.now() < deadline) await delay(10);
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
    await Promise.allSettled(this.contexts.map((context) => context.target.send("Page.stopScreencast")));
    for (const context of this.contexts) context.target.off("Page.screencastFrame", context.listener);
    await this.spools.close();
  }

  async finalize(input: { readonly status: "success" | "failed" | "interrupted"; readonly failures: readonly RecorderFailure[]; readonly events?: readonly RecorderFlowEvent[] }): Promise<RecordingFinalizeResult> {
    if (this.finalized) throw new Error("recording session already finalized");
    this.finalized = true;
    if (this.t0Us === undefined) {
      if (this.state !== "failed") await this.transition("failed");
      await this.stopCapture();
      const diagnosticsPath = join(this.options.outputDir, "diagnostics.json");
      await atomicJson(diagnosticsPath, { contract: null, status: input.status, failures: input.failures });
      return { kind: "diagnostics", diagnosticsPath };
    }

    const elapsedUs = Math.max(0, monotonicUs() - (this.flowStartUs ?? monotonicUs()));
    await this.transition("post-roll");
    await delay(POST_ROLL_US / 1000);
    const t1Us = this.t0Us + elapsedUs + POST_ROLL_US;
    await this.transition("stopping");
    await this.stopCapture();
    await this.transition("aligning");
    const durationFrames = durationFrameCount(this.t0Us, t1Us, this.options.recording.fps);
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
    const verification = await verifyArtifacts(this.options.outputDir, this.options.recording.fps, durationFrames);
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
      status: input.status,
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
      failures: input.failures,
      flowEvents: input.events ?? [],
      artifacts,
      sha256: hashes,
    };
    const manifestPath = join(this.options.outputDir, "manifest.json");
    await atomicJson(manifestPath, manifest);
    await this.transition("complete");
    const statePath = join(this.options.outputDir, "run-state.json");
    const stateKey = relative(this.options.outputDir, statePath);
    const finalManifest = { ...manifest, artifacts: { ...manifest.artifacts, "run-state.json": stateKey }, sha256: { ...manifest.sha256, [stateKey]: await sha256(statePath) } };
    await atomicJson(manifestPath, finalManifest);
    if (!this.options.recording.keepRaw) await fs.rm(join(this.options.outputDir, "raw"), { recursive: true, force: true });
    return { kind: "manifest", manifestPath, manifest: finalManifest };
  }
}
