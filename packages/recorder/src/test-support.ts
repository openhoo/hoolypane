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
 * not re-exported from the package barrel): appends each spec's synthesized JPEGs into
 * `<directory>/raw/<id>`, aligns the recorded frames onto [t0Us, durationFrames) slots at fps, and
 * returns the exact track tuple encodeAligned expects.
 */
export async function buildAlignedTracks(
  directory: string,
  specs: readonly AlignedTrackSpec[],
  t0Us: number,
  durationFrames: number,
  fps: 30 | 60,
  options: { readonly swallowCloseErrors?: boolean } = {},
): Promise<BuiltAlignedTrack[]> {
  return Promise.all(specs.map(async (spec): Promise<BuiltAlignedTrack> => {
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
