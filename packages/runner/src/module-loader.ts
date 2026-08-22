import { build } from "esbuild";
import type { Plugin, PluginBuild } from "esbuild";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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

// User artifacts bundle bare "@hoolypane/*" specifiers and keep "playwright" external at an absolute
// file URL, so artifacts load regardless of installation location: "@hoolypane/*" resolution walks up
// from the runner installation itself (pure fs access; import.meta.resolve is unavailable under
// Vitest/Vite SSR transforms), while playwright resolves through Node's own resolver in the runner's
// module context, keeping exports conditions authoritative. Playwright's own dependencies
// (playwright-core) resolve from the playwright package's real location.
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

// Playwright stays external at an absolute file URL so its own dependencies (playwright-core) resolve
// from the playwright package's real location. createRequire locates the package through Node's own
// resolver, but its "require" condition returns the CJS entry whose re-export chain cjs-module-lexer
// cannot statically see — `import { chromium }` in the artifact would fail. So walk up to the package
// root and pick the "import"-condition entry (ESM) explicitly; bare-string export targets serve every
// condition and are therefore already covered by the CJS path.
function playwrightEntry(): string {
  const located = createRequire(import.meta.url).resolve("playwright");
  let dir = dirname(located);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) break;
    const parent = dirname(dir);
    if (parent === dir) return located;
    dir = parent;
  }
  const manifestPath = join(dir, "package.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return located;
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return located;
  // JSON boundary: member reads below are guarded by in-checks on this record.
  const manifestRecord = manifest as Record<string, unknown>;
  if (!("name" in manifestRecord) || manifestRecord.name !== "playwright") return located;
  if (!("exports" in manifestRecord)) return located;
  const exportTable: unknown = manifestRecord.exports;
  if (typeof exportTable !== "object" || exportTable === null || Array.isArray(exportTable)) return located;
  // Same JSON boundary as above for the exports table.
  const exportRecord = exportTable as Record<string, unknown>;
  if (!("." in exportRecord)) return located;
  const rootExport: unknown = exportRecord["."];
  if (rootExport === null || typeof rootExport !== "object" || Array.isArray(rootExport)) return located;
  // Conditional map object: guarded member access via in-narrowing.
  const conditions = rootExport as Record<string, unknown>;
  const target: unknown = "import" in conditions ? conditions.import : "default" in conditions ? conditions.default : undefined;
  return typeof target === "string" ? join(dir, target) : located;
}

// Emits a relative external specifier from the artifact to playwright's ESM entry, so Node loads the
// real ESM file (named exports intact) while esbuild keeps it out of the bundle. Path separators are
// normalized to "/" because ESM import specifiers always use forward slashes.
function playwrightResolution(artifactPath: string): Plugin {
  return {
    name: "playwright-resolution",
    setup(pluginBuild: PluginBuild): void {
      pluginBuild.onResolve({ filter: /^playwright$/ }, () => {
        const specifier = relative(dirname(artifactPath), playwrightEntry()).split(sep).join("/");
        // Degenerate result of cross-drive inputs (artifact on C:, playwright on D:) is an
        // absolute path, not a specifier; Node would fail the artifact with ERR_UNSUPPORTED_ESM_URL_SCHEME.
        if (!specifier.startsWith(".")) {
          throw new Error(
            `cannot express the playwright ESM entry (${specifier}) as a module-relative specifier from ${artifactPath}: ` +
            "cross-drive absolute paths are unsupported; keep playwright on the same drive as the runner cache",
          );
        }
        return { path: specifier, external: true };
      });
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
    plugins: [hoolypaneResolution(), playwrightResolution(outputPath)],
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
