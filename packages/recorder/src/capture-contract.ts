import { encodedDimension, type ViewportSpec } from "@hoolypane/contracts";

export const CAPTURE_CONTRACT = "multi-viewport-cfr-v1" as const;
export const VALIDATOR_VERSION = 1;
export const POST_ROLL_US = 250_000;
export const MAX_QUEUED_FRAMES = 8;
export const MAX_QUEUED_BYTES = 32 * 1024 * 1024;

// libvpx's VP8 encoder rejects any dimension above 16383 px ("Invalid parameter", verified against the pinned
// ffmpeg-static build), one pixel below the 16384 config ceiling; folding the codec limit into the fit scale
// keeps composite outputs encodable while preserving aspect ratio.
const VP8_MAX_DIMENSION = 16_383;

export type RecordingState = "awaiting-initial-frames" | "recording" | "post-roll" | "stopping" | "aligning" | "encoding" | "validating" | "complete" | "failed";
const NEXT_STATES: Readonly<Record<RecordingState, readonly RecordingState[]>> = {
  "awaiting-initial-frames": ["recording", "failed"],
  recording: ["post-roll", "failed"],
  "post-roll": ["stopping", "failed"],
  stopping: ["aligning", "failed"],
  aligning: ["encoding", "failed"],
  encoding: ["validating", "failed"],
  validating: ["complete", "failed"],
  complete: [],
  failed: [],
};

export interface SourceFrame { readonly offset: number; readonly length: number; readonly sequence: number; readonly width: number; readonly height: number; readonly timestampUs: number }
export interface SlotMapping { readonly slot: number; readonly targetTimestampUs: number; readonly sourceSequence: number; readonly sourceTimestampUs: number; readonly held: boolean }
export interface TrackGeometry { readonly id: string; readonly encodedWidth: number; readonly encodedHeight: number }
export interface CompositeGeometry { readonly columns: number; readonly rows: number; readonly tileWidth: number; readonly tileHeight: number; readonly unscaledWidth: number; readonly unscaledHeight: number; readonly outputWidth: number; readonly outputHeight: number }

export function assertStateTransition(from: RecordingState, to: RecordingState): void {
  if (!NEXT_STATES[from].includes(to)) throw new Error(`invalid recorder state transition: ${from} -> ${to}`);
}

export function timestampSecondsToUs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("screencast frame is missing a valid CDP timestamp");
  const microseconds = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(microseconds)) throw new Error("screencast timestamp exceeds integer microsecond range");
  return microseconds;
}

export function geometryForViewport(viewport: ViewportSpec): TrackGeometry {
  return { id: viewport.id, encodedWidth: encodedDimension(viewport.width, viewport.deviceScaleFactor), encodedHeight: encodedDimension(viewport.height, viewport.deviceScaleFactor) };
}

function evenFloor(value: number): number {
  return Math.max(2, 2 * Math.floor(value / 2));
}

export function compositeGeometry(tracks: readonly TrackGeometry[], maximum: { readonly width: number; readonly height: number }): CompositeGeometry {
  if (tracks.length === 0) throw new Error("at least one viewport is required");
  if (maximum.width < 2 || maximum.height < 2) throw new Error("composite maximum dimensions must be at least 2");
  const columns = Math.ceil(Math.sqrt(tracks.length));
  const rows = Math.ceil(tracks.length / columns);
  const tileWidth = Math.max(...tracks.map((track) => track.encodedWidth));
  const tileHeight = Math.max(...tracks.map((track) => track.encodedHeight));
  const unscaledWidth = tileWidth * columns;
  const unscaledHeight = tileHeight * rows;
  const scale = Math.min(1, maximum.width / unscaledWidth, maximum.height / unscaledHeight, VP8_MAX_DIMENSION / unscaledWidth, VP8_MAX_DIMENSION / unscaledHeight);
  return {
    columns,
    rows,
    tileWidth,
    tileHeight,
    unscaledWidth,
    unscaledHeight,
    outputWidth: evenFloor(unscaledWidth * scale),
    outputHeight: evenFloor(unscaledHeight * scale),
  };
}

export function durationFrameCount(t0Us: number, t1Us: number, fps: 30 | 60): number {
  if (!Number.isSafeInteger(t0Us) || !Number.isSafeInteger(t1Us) || t1Us < t0Us) throw new Error("invalid recording timeline");
  return Math.max(1, Math.ceil((t1Us - t0Us) * fps / 1_000_000));
}

export function alignFrames(frames: readonly SourceFrame[], t0Us: number, durationFrames: number, fps: 30 | 60): { mappings: SlotMapping[]; heldFrames: number; maximumSkewUs: number } {
  if (frames.length === 0) throw new Error("cannot align an empty frame track");
  const sorted = [...frames].sort((left, right) => left.timestampUs - right.timestampUs || left.sequence - right.sequence);
  let selected = sorted.findLastIndex((frame) => frame.timestampUs <= t0Us);
  if (selected < 0) throw new Error("no source frame exists at or before T0");
  const mappings: SlotMapping[] = [];
  let heldFrames = 0;
  let maximumSkewUs = 0;
  for (let slot = 0; slot < durationFrames; slot += 1) {
    const targetTimestampUs = t0Us + Math.floor(slot * 1_000_000 / fps);
    while (selected + 1 < sorted.length && sorted[selected + 1]!.timestampUs <= targetTimestampUs) selected += 1;
    const source = sorted[selected]!;
    const held = slot > 0 && mappings[slot - 1]!.sourceSequence === source.sequence;
    if (held) heldFrames += 1;
    maximumSkewUs = Math.max(maximumSkewUs, targetTimestampUs - source.timestampUs);
    mappings.push({ slot, targetTimestampUs, sourceSequence: source.sequence, sourceTimestampUs: source.timestampUs, held });
  }
  return { mappings, heldFrames, maximumSkewUs };
}
