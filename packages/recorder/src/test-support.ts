import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACT_DIRECTORIES, alignFrames, type SlotMapping, type TrackGeometry } from "./capture-contract.js";
import { FrameSpool } from "./spool.js";

interface AlignedTrackSpec {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly frames: number;
  /** Synthesizes the JPEG appended for `sequence`; lets each caller own its frame content strategy. */
  readonly jpeg: (sequence: number) => Promise<Buffer>;
  readonly timestampUs: (sequence: number) => number;
}

interface BuiltAlignedTrack { readonly id: string; readonly spool: FrameSpool; readonly mappings: readonly SlotMapping[]; readonly geometry: TrackGeometry }

/**
 * Shared synthetic spool-track builder for encodeAligned consumers (test-only support, deliberately
 * not re-exported from the package barrel): appends each spec's synthesized JPEGs into the id-keyed
 * spool files `<directory>/raw/<id>.jpeg.bin` (+ `<id>.index.json`), aligns the recorded frames
 * onto [t0Us, durationFrames) slots at fps, and returns the exact track tuple encodeAligned expects.
 */
export async function buildAlignedTracks(
  directory: string,
  specs: readonly AlignedTrackSpec[],
  t0Us: number,
  durationFrames: number,
  fps: 30 | 60,
  options: { readonly swallowCloseErrors?: boolean } = {},
): Promise<BuiltAlignedTrack[]> {
  // Duplicate ids would interleave appends into one spool file while each FrameSpool allocates
  // offsets from zero — loud failure here beats far-away corruption (mirrors CaptureSpool.create()).
  // The check runs synchronously before any await, so it races nothing.
  const seenIds = new Set<string>();
  return Promise.all(specs.map(async (spec): Promise<BuiltAlignedTrack> => {
    if (seenIds.has(spec.id)) throw new Error(`duplicate aligned track id: ${spec.id}`);
    seenIds.add(spec.id);
    const spool = new FrameSpool(spec.id, join(directory, ARTIFACT_DIRECTORIES.raw));
    await spool.open();
    let primaryError: unknown;
    try {
      for (let sequence = 0; sequence < spec.frames; sequence += 1) {
        await spool.append(await spec.jpeg(sequence), { sequence, width: spec.width, height: spec.height, timestampUs: spec.timestampUs(sequence) });
      }
    } catch (error) {
      primaryError = error;
    }
    // A cleanup close failure must never mask the capture failure that caused it.
    await spool.close().catch((error: unknown) => {
      if (primaryError === undefined && options.swallowCloseErrors !== true) throw error;
    });
    if (primaryError !== undefined) throw primaryError;
    const alignment = alignFrames(spool.index.frames, t0Us, durationFrames, fps);
    return { id: spec.id, spool, mappings: alignment.mappings, geometry: { id: spec.id, encodedWidth: spec.width, encodedHeight: spec.height } };
  }));
}

// Shared scratch-directory registry for unit suites: each test registers its mkdtemp directory
// and vitest's shared afterEach removes whatever is registered when the test ends. Unlike
// buildAlignedTracks above, these two helpers are re-exported from the package barrel so
// cross-package suites (the runner's verify suite) register through the same registry.
const scratchDirectories: string[] = [];

export function trackScratchDirectory(directory: string): void {
  scratchDirectories.push(directory);
}

export async function removeScratchDirectories(): Promise<void> {
  await Promise.all(scratchDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
}
