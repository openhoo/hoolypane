#!/usr/bin/env node
import { parseCliArguments } from "./cli-arguments.js";
import { runFlow } from "./run-flow.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyArtifacts } from "@hoolypane/recorder";


async function verifyDirectory(path: string): Promise<number> {
  const outputDir = resolve(path);
  const value = JSON.parse(await readFile(resolve(outputDir, "manifest.json"), "utf8")) as unknown;
  // No runtime schema for RecordingManifest exists yet (@hoolypane/recorder exports the type only); these checks mirror the fps 30|60 and durationFrames >= 1 contract by hand.
  if (!value || typeof value !== "object" || !("fps" in value) || !("durationFrames" in value)) throw new Error("manifest.json lacks fps or durationFrames");
  const fps = value.fps;
  const durationFrames = value.durationFrames;
  if ((fps !== 30 && fps !== 60) || typeof durationFrames !== "number" || !Number.isInteger(durationFrames) || durationFrames < 1) throw new Error("manifest.json has invalid fps or durationFrames");
  const result = await verifyArtifacts(outputDir, fps, durationFrames);
  if (!result.success) throw new Error(result.error ?? "artifact verification failed");
  process.stdout.write(`Verified ${durationFrames} aligned frames in ${outputDir}\n`);
  return 0;
}
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    if (argv[0] === "verify") {
      if (!argv[1] || argv.length !== 2) throw new Error("Usage: hoolypane verify <output-dir>");
      return await verifyDirectory(argv[1]);
    }
    const args = parseCliArguments(argv);
    const result = await runFlow(args);
    if (result.status === "interrupted") return 130;
    return result.status === "success" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

main().then((code) => { process.exitCode = code; });
