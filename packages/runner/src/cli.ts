#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { errorMessage } from "@hoolypane/contracts";
import { parseCliArguments, TOP_LEVEL_USAGE } from "./cli-arguments.js";
import { runFlow } from "./run-flow.js";
import { verifyDirectory } from "./verify.js";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    if (argv[0] === "-h" || argv[0] === "--help") {
      process.stdout.write(`${TOP_LEVEL_USAGE}\n`);
      return 0;
    }
    if (argv[0] === "verify") {
      if (!argv[1] || argv.length !== 2) throw new Error("Usage: hoolypane verify <output-dir>");
      return await verifyDirectory(argv[1]);
    }
    const args = parseCliArguments(argv);
    const result = await runFlow(args);
    if (result.status === "interrupted") return 130;
    return result.status === "success" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }
}

// Deadline losers (a raced-out module evaluation, a timed-out user flow) keep running
// user-module timers/servers that nothing can dispose, so the entry point must force exit
// once its own output is flushed or a leaked interval would hang the process forever.
// A zero-length write callback fires once all queued bytes flushed; 'drain' never fires for
// short writes that never returned false (macOS pipes deliver stdio asynchronously).
async function exitAfterFlush(code: number): Promise<void> {
  const pending = [process.stdout, process.stderr].filter((stream) => stream.writableLength > 0);
  if (pending.length > 0) await Promise.all(pending.map((stream) => new Promise<void>((resolve) => stream.write("", () => resolve()))));
  process.exit(code);
}

// Only the executed entry forces exit; importing this module stays side-effect-free so tests
// and programmatic callers can drive main() in-process.
if (process.argv[1] !== undefined) {
  try {
    if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void main().then(exitAfterFlush);
  } catch { /* unresolvable argv[1]: never the executed entry */ }
}
