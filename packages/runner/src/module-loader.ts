import { build } from "esbuild";
import type { Plugin, PluginBuild } from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

export interface CompiledModule {
  readonly path: string;
  readonly cleanup: () => Promise<void>;
}

// Artifacts of crashed runs (SIGKILL/SIGSEGV bypass the runner-side cleanup) are pruned by age.
const STALE_ARTIFACT_AGE_MS = 24 * 60 * 60 * 1000;

async function pruneStaleArtifacts(cacheDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(cacheDir);
  } catch {
    return;
  }
  const now = Date.now();
  await Promise.allSettled(entries.map(async (name) => {
    const filePath = resolve(cacheDir, name);
    try {
      const info = await stat(filePath);
      if (info.isFile() && now - info.mtimeMs > STALE_ARTIFACT_AGE_MS) await rm(filePath, { force: true });
    } catch {
      // A concurrently removed or unreadable entry is not a compile failure.
    }
  }));
}

// User artifacts bundle bare "@hoolypane/*" and "playwright" specifiers so they load regardless of
// installation location; recorded flows may live outside any node_modules tree, so resolution walks up
// from the runner installation itself. Playwright stays external at an absolute file URL, so its own
// dependencies (playwright-core) resolve from the playwright package's real location. Pure fs access only:
// import.meta.resolve is unavailable under Vitest/Vite SSR transforms.
function hoolypaneEntry(specifier: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const packageDir = join(dir, "node_modules", specifier);
    const manifestPath = join(packageDir, "package.json");
    if (existsSync(manifestPath)) {
      const sourceEntry = join(packageDir, "src", "index.ts");
      if (existsSync(sourceEntry)) return sourceEntry;
      let manifest: unknown;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch (error) {
        throw new Error(`Cannot resolve ${specifier}: ${manifestPath} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
      }
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error(`Cannot resolve ${specifier}: ${manifestPath} is not a valid package manifest`);
      const manifestRecord = manifest as Record<string, unknown>; // JSON boundary; null/array/non-object rejected above.
      const exportsField: unknown = manifestRecord.exports;
      const main: unknown = manifestRecord.main;
      const exportTable: Record<string, unknown> | undefined = exportsField && typeof exportsField === "object" && !Array.isArray(exportsField)
        ? exportsField as Record<string, unknown> // keys are arbitrary specifiers by contract.
        : undefined;
      const rootExport: unknown = exportTable?.["."];
      let target: string | undefined;
      if (typeof rootExport === "string") {
        target = rootExport;
      } else if (rootExport !== null && typeof rootExport === "object" && "import" in rootExport) {
        const importCandidate: unknown = rootExport.import;
        if (typeof importCandidate === "string") target = importCandidate;
      }
      return join(packageDir, target ?? (typeof main === "string" ? main : undefined) ?? "index.js");
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Cannot resolve ${specifier} from the runner installation`);
    dir = parent;
  }
}

function hoolypaneResolution(): Plugin {
  return {
    name: "hoolypane-resolution",
    setup(pluginBuild: PluginBuild): void {
      pluginBuild.onResolve({ filter: /^@hoolypane\// }, (args) => ({ path: hoolypaneEntry(args.path) }));
    },
  };
}

function playwrightResolution(): Plugin {
  return {
    name: "playwright-resolution",
    setup(pluginBuild: PluginBuild): void {
      pluginBuild.onResolve({ filter: /^playwright$/ }, (args) => ({ path: pathToFileURL(hoolypaneEntry(args.path)).href }));
    },
  };
}

export async function compileModule(entryFile: string, cacheDir: string): Promise<CompiledModule> {
  const absoluteEntry = resolve(entryFile);
  await mkdir(cacheDir, { recursive: true });
  await pruneStaleArtifacts(cacheDir);
  const digest = createHash("sha256").update(absoluteEntry).digest("hex").slice(0, 16);
  const outputPath = resolve(cacheDir, `${digest}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  await build({
    entryPoints: [absoluteEntry],
    outfile: outputPath,
    bundle: true,
    plugins: [hoolypaneResolution(), playwrightResolution()],
    format: "esm",
    platform: "node",
    target: "node24",
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
  if (!value || typeof value !== "object" || !("run" in value) || typeof value.run !== "function") {
    throw new Error(`${source} must export a FlowDefinition as default or flow`);
  }
}
