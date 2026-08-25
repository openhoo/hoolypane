import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyArtifacts } from "@hoolypane/recorder";

export async function verifyDirectory(path: string): Promise<number> {
  const outputDir = resolve(path);
  const manifestPath = resolve(outputDir, "manifest.json");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || !("fps" in value) || !("durationFrames" in value)) throw new Error(`${manifestPath} lacks fps or durationFrames`);
  const fps = value.fps;
  const durationFrames = value.durationFrames;
  if ((fps !== 30 && fps !== 60) || typeof durationFrames !== "number" || !Number.isInteger(durationFrames) || durationFrames < 1) throw new Error(`${manifestPath} has invalid fps or durationFrames`);
  // No runtime schema for RecordingManifest exists yet (the recorder declares the type internally); these checks mirror the fps 30|60 and durationFrames >= 1 contract by hand.
  // Geometry expectations are optional: directories recorded before the geometry contract lack the fields and still verify on the timeline contract alone.
  const manifestRecord = value as Record<string, unknown>; // JSON boundary; object shape checked above.
  // A manifest whose own status records a non-success run must not certify: timeline and geometry
  // can both be intact (alignFrames fills held frames) while a pane's capture ended early or
  // tracing failed — exactly what flipped the run that wrote this manifest to "failed".
  if (manifestRecord.status !== undefined && manifestRecord.status !== "success") {
    const reasons = Array.isArray(manifestRecord.failures)
      ? manifestRecord.failures
          .map((failure) => (typeof failure === "object" && failure !== null && typeof (failure as Record<string, unknown>).message === "string" ? (failure as Record<string, unknown>).message : JSON.stringify(failure)))
          .join("; ")
      : "";
    throw new Error(`${manifestPath} records status "${String(manifestRecord.status)}"${reasons ? `: ${reasons}` : ""}`);
  }
  let tracks: Array<{ id: string; encodedWidth: number; encodedHeight: number }> = [];
  if (manifestRecord.viewports !== undefined) {
    if (!Array.isArray(manifestRecord.viewports)) throw new Error(`${manifestPath} has a malformed viewports field: expected an array`);
    // A present-but-empty array must fail loudly for the same reason: ViewportListSchema
    // enforces min(1) viewport, so silently degrading to timeline-only would claim success.
    if (manifestRecord.viewports.length === 0) throw new Error(`${manifestPath} has an empty viewports field: at least one viewport entry is required`);
    // A present-but-malformed entry must fail loudly: silently dropping it would degrade
    // geometry verification to timeline-only while claiming success.
    for (const [index, viewport] of manifestRecord.viewports.entries()) {
      const valid = typeof viewport === "object" && viewport !== null
        && typeof (viewport as Record<string, unknown>).id === "string"
        && typeof (viewport as Record<string, unknown>).encodedWidth === "number"
        && typeof (viewport as Record<string, unknown>).encodedHeight === "number";
      if (!valid) throw new Error(`${manifestPath} has a malformed viewports[${index}] entry: { id: string, encodedWidth: number, encodedHeight: number } is required`);
      const entry = viewport as Record<string, unknown>;
      tracks.push({ id: entry.id as string, encodedWidth: entry.encodedWidth as number, encodedHeight: entry.encodedHeight as number });
    }
  }
  let expectedGeometry: { tracks: Array<{ id: string; encodedWidth: number; encodedHeight: number }>; composite: { width: number; height: number } } | undefined;
  if (manifestRecord.geometry !== undefined) {
    // A present-but-malformed geometry must fail loudly: silently treating it as absent
    // would degrade geometry verification to timeline-only while claiming success.
    const geometry = manifestRecord.geometry;
    const valid = typeof geometry === "object" && geometry !== null
      && typeof (geometry as Record<string, unknown>).outputWidth === "number"
      && typeof (geometry as Record<string, unknown>).outputHeight === "number";
    if (!valid) throw new Error(`${manifestPath} has a malformed geometry field: { outputWidth: number, outputHeight: number } is required`);
    // Geometry without any viewport entries must fail loudly like malformed geometry: with no
    // tracks, verification would silently degrade to timeline-only while claiming success.
    if (tracks.length === 0) throw new Error(`${manifestPath} has geometry without viewports: at least one viewport entry is required`);
    const record = geometry as Record<string, unknown>;
    expectedGeometry = { tracks, composite: { width: record.outputWidth as number, height: record.outputHeight as number } };
  }
  const result = await verifyArtifacts(outputDir, fps, durationFrames, expectedGeometry);
  if (!result.success) throw new Error(result.error ?? "artifact verification failed");
  process.stdout.write(`Verified ${durationFrames} aligned frames in ${outputDir}\n`);
  return 0;
}
