import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

interface CompiledModule {
  readonly path: string;
  readonly cleanup: () => Promise<void>;
}

export async function compileModule(entryFile: string, cacheDir: string): Promise<CompiledModule> {
  const absoluteEntry = resolve(entryFile);
  await mkdir(cacheDir, { recursive: true });
  const digest = createHash("sha256").update(absoluteEntry).digest("hex").slice(0, 16);
  const outputPath = resolve(cacheDir, `${digest}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  await build({
    entryPoints: [absoluteEntry],
    outfile: outputPath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    packages: "external",
    sourcemap: false,
    logLevel: "silent",
  });
  return {
    path: outputPath,
    cleanup: async () => {
      await rm(outputPath, { force: true });
      await rm(`${outputPath}.map`, { force: true });
    },
  };
}

export function validateConfigExport(value: unknown, source: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error(`${source} must export a configuration object as default or config`);
}

export function validateFlowExport(value: unknown, source: string): asserts value is { run: Function } {
  if (!value || typeof value !== "object" || typeof (value as { run?: unknown }).run !== "function") {
    throw new Error(`${source} must export a FlowDefinition as default or flow`);
  }
}
