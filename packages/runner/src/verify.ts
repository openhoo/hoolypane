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
  // No runtime schema for RecordingManifest exists yet (@hoolypane/recorder exports the type only); these checks mirror the fps 30|60 and durationFrames >= 1 contract by hand.
  // Geometry expectations are optional: directories recorded before the geometry contract lack the fields and still verify on the timeline contract alone.
  const manifestRecord = value as Record<string, unknown>; // JSON boundary; object shape checked above.
  let tracks: Array<{ id: string; encodedWidth: number; encodedHeight: number }> = [];
  if (manifestRecord.viewports !== undefined) {
    if (!Array.isArray(manifestRecord.viewports)) throw new Error(`${manifestPath} has a malformed viewports field: expected an array`);
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
  const geometry = manifestRecord.geometry && typeof manifestRecord.geometry === "object" ? manifestRecord.geometry as Record<string, unknown> : undefined;
  const expectedGeometry = tracks.length > 0 && geometry && typeof geometry.outputWidth === "number" && typeof geometry.outputHeight === "number"
    ? { tracks, composite: { width: geometry.outputWidth, height: geometry.outputHeight } }
    : undefined;
  const result = await verifyArtifacts(outputDir, fps, durationFrames, expectedGeometry);
  if (!result.success) throw new Error(result.error ?? "artifact verification failed");
  process.stdout.write(`Verified ${durationFrames} aligned frames in ${outputDir}\n`);
  return 0;
}
