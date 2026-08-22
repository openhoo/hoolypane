#!/usr/bin/env node
import { parseCliArguments } from "./cli-arguments.js";
import { runFlow } from "./run-flow.js";
import { verifyDirectory } from "./verify.js";

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
