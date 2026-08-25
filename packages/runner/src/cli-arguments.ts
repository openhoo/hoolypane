export interface RunArguments {
  readonly flowFile: string;
  readonly configFile: string;
  readonly outputDir?: string;
  readonly headed: boolean;
}

const USAGE = "Usage: hoolypane run <flow-file> [--config <path>] [--output <dir>] [--headed]";

export const TOP_LEVEL_USAGE = [
  "Usage: hoolypane <command>",
  "",
  "Commands:",
  "  run <flow-file> [--config <path>] [--output <dir>] [--headed]",
  "      Record a flow across all configured viewports.",
  "  verify <output-dir>",
  "      Verify the manifest and encoded frames of a finished recording.",
  "",
  "Options:",
  "  -h, --help  Show this help and exit",
].join("\n");

export function parseCliArguments(argv: readonly string[]): RunArguments {
  if (argv[0] !== "run" || !argv[1] || argv[1].startsWith("-")) throw new Error(USAGE);

  let configFile = "hoolypane.config.ts";
  let outputDir: string | undefined;
  let headed = false;
  let configSeen = false;
  let outputSeen = false;

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--headed") {
      if (headed) throw new Error("--headed may be specified only once");
      headed = true;
      continue;
    }
    if (argument === "--config" || argument === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${argument} requires a path\n${USAGE}`);
      if (argument === "--config") {
        if (configSeen) throw new Error("--config may be specified only once");
        configSeen = true;
        configFile = value;
      } else {
        if (outputSeen) throw new Error("--output may be specified only once");
        outputSeen = true;
        outputDir = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}\n${USAGE}`);
  }

  return { flowFile: argv[1], configFile, headed, ...(outputDir === undefined ? {} : { outputDir }) };
}
