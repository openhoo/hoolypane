import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { errorMessage, RECORDING_FPS_VALUES } from "@hoolypane/contracts";
import { MANIFEST_FILE, sha256File, verifyArtifacts } from "@hoolypane/recorder";
import type { TrackGeometry } from "@hoolypane/recorder";

// JSON-boundary guard shared by every hand-rolled manifest check below: value must be a
// non-null object whose named fields carry the expected primitive types. Until a runtime
// RecordingManifest schema exists these checks mirror the recording contract by hand.
function hasJsonFields(value: unknown, fields: Readonly<Record<string, "string" | "number">>): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(fields).every(([field, type]) => typeof (value as Record<string, unknown>)[field] === type);
}

async function parseManifestHeader(manifestPath: string): Promise<{ fps: (typeof RECORDING_FPS_VALUES)[number]; durationFrames: number; record: Record<string, unknown> }> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse ${manifestPath}: ${errorMessage(error)}`);
  }
  if (!value || typeof value !== "object" || !("fps" in value) || !("durationFrames" in value)) throw new Error(`${manifestPath} lacks fps or durationFrames`);
  const fps = value.fps;
  const durationFrames = value.durationFrames;
  if (!RECORDING_FPS_VALUES.includes(fps as (typeof RECORDING_FPS_VALUES)[number]) || typeof durationFrames !== "number" || !Number.isInteger(durationFrames) || durationFrames < 1) throw new Error(`${manifestPath} has invalid fps or durationFrames`);
  // No runtime schema for RecordingManifest exists yet (the recorder declares the type internally); these checks mirror the fps 30|60 and durationFrames >= 1 contract by hand.
  return { fps: fps as (typeof RECORDING_FPS_VALUES)[number], durationFrames, record: value as Record<string, unknown> }; // JSON boundary; object shape checked above.
}

function parseTrackGeometries(record: Record<string, unknown>, manifestPath: string): TrackGeometry[] {
  const tracks: TrackGeometry[] = [];
  if (record.viewports === undefined) return tracks;
  if (!Array.isArray(record.viewports)) throw new Error(`${manifestPath} has a malformed viewports field: expected an array`);
  // A present-but-empty array must fail loudly for the same reason: ViewportListSchema
  // enforces min(1) viewport, so silently degrading to timeline-only would claim success.
  if (record.viewports.length === 0) throw new Error(`${manifestPath} has an empty viewports field: at least one viewport entry is required`);
  // A present-but-malformed entry must fail loudly: silently dropping it would degrade
  // geometry verification to timeline-only while claiming success.
  for (const [index, viewport] of record.viewports.entries()) {
    if (!hasJsonFields(viewport, { id: "string", encodedWidth: "number", encodedHeight: "number" })) throw new Error(`${manifestPath} has a malformed viewports[${index}] entry: { id: string, encodedWidth: number, encodedHeight: number } is required`);
    tracks.push({ id: viewport.id as string, encodedWidth: viewport.encodedWidth as number, encodedHeight: viewport.encodedHeight as number });
  }
  return tracks;
}

function parseCompositeGeometry(record: Record<string, unknown>, tracks: TrackGeometry[], manifestPath: string): { tracks: TrackGeometry[]; composite: { width: number; height: number } } {
  // A present-but-malformed geometry must fail loudly: silently treating it as absent
  // would degrade geometry verification to timeline-only while claiming success.
  const geometry = record.geometry;
  if (!hasJsonFields(geometry, { outputWidth: "number", outputHeight: "number" })) throw new Error(`${manifestPath} has a malformed geometry field: { outputWidth: number, outputHeight: number } is required`);
  // Geometry without any viewport entries must fail loudly like malformed geometry: with no
  // tracks, verification would silently degrade to timeline-only while claiming success.
  if (tracks.length === 0) throw new Error(`${manifestPath} has geometry without viewports: at least one viewport entry is required`);
  return { tracks, composite: { width: geometry.outputWidth as number, height: geometry.outputHeight as number } };
}

// Certifies every entry of the manifest's own optional sha256 map: videos arrive freshly hashed
// in result.sha256 under their `videos/<name>` keys; remaining entries (traces/*, run-state.json)
// are hashed on demand. A corrupted or tampered payload must fail loudly instead of being
// certified by ffprobe timeline/geometry agreement alone — mirrors the loud-failure philosophy
// applied to degraded geometry/status checks above. Directories recorded before the hash
// contract lack the optional map and skip certification.
async function certifyManifestHashes(outputDir: string, manifestPath: string, record: Record<string, unknown>, verifiedHashes: Readonly<Record<string, string>>): Promise<void> {
  const map: unknown = record.sha256;
  // An absent map legitimately skips certification for recordings made before the hash contract;
  // anything present-but-malformed must fail loudly like every sibling degraded-field check above.
  if (map === undefined) return;
  if (typeof map !== "object" || map === null || Array.isArray(map)) throw new Error(`${manifestPath} has a malformed sha256 field: expected an object mapping artifact paths to digests`);
  for (const [key, expected] of Object.entries(map)) {
    // finalize writes hex-string digests exclusively, so a non-string entry can only be corruption
    // or tampering — exactly the threat this certification exists to catch.
    if (typeof expected !== "string") throw new Error(`${manifestPath} artifact ${key} lacks a string sha256 digest`);
    let actual: string;
    try {
      actual = verifiedHashes[key] ?? (await sha256File(resolve(outputDir, key)));
    } catch (error) {
      throw new Error(`${manifestPath} artifact ${key} fails sha256 certification (${errorMessage(error)})`);
    }
    if (actual !== expected) throw new Error(`${manifestPath} artifact ${key} fails sha256 certification`);
  }
}

export async function verifyDirectory(path: string): Promise<number> {
  const outputDir = resolve(path);
  const manifestPath = resolve(outputDir, MANIFEST_FILE);
  const { fps, durationFrames, record: manifestRecord } = await parseManifestHeader(manifestPath);
  // A manifest whose own status records a non-success run must not certify: timeline and geometry
  // can both be intact (alignFrames fills held frames) while a pane's capture ended early or
  // tracing failed — exactly what flipped the run that wrote this manifest to "failed".
  if (manifestRecord.status !== undefined && manifestRecord.status !== "success") {
    const reasons = Array.isArray(manifestRecord.failures)
      ? manifestRecord.failures
          .map((failure) => (hasJsonFields(failure, { message: "string" }) ? failure.message : JSON.stringify(failure)))
          .join("; ")
      : "";
    throw new Error(`${manifestPath} records status "${String(manifestRecord.status)}"${reasons ? `: ${reasons}` : ""}`);
  }
  const tracks = parseTrackGeometries(manifestRecord, manifestPath);
  // Geometry expectations are optional: directories recorded before the geometry contract lack the fields and still verify on the timeline contract alone.
  let expectedGeometry: { tracks: TrackGeometry[]; composite: { width: number; height: number } } | undefined;
  if (manifestRecord.geometry !== undefined) expectedGeometry = parseCompositeGeometry(manifestRecord, tracks, manifestPath);
  const result = await verifyArtifacts(outputDir, fps, durationFrames, expectedGeometry);
  if (!result.success) throw new Error(result.error ?? "artifact verification failed");
  await certifyManifestHashes(outputDir, manifestPath, manifestRecord, result.sha256);
  process.stdout.write(`Verified ${durationFrames} aligned frames in ${outputDir}\n`);
  return 0;
}
