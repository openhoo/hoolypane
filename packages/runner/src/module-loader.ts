import { build } from "esbuild";
import type { Plugin, PluginBuild } from "esbuild";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
// Splits a filtered "/^@hoolypane\//" specifier into its scoped package name ("@scope/name") and
// package subpath ("." or "./deep/path"), mirroring Node's specifier grammar for scoped names.
function splitHoolypaneSpecifier(specifier: string): { packageName: string; packageSubpath: string } {
  const segments = specifier.split("/");
  return { packageName: `${segments[0]}/${segments[1]}`, packageSubpath: segments.length > 2 ? `./${segments.slice(2).join("/")}` : "." };
}

// Picks the importable target of one exports entry: plain strings serve every module condition,
// conditional maps prefer the "import" condition and fall back to "default".
function exportTarget(exportValue: unknown): string | undefined {
  if (typeof exportValue === "string") return exportValue;
  if (exportValue !== null && typeof exportValue === "object" && !Array.isArray(exportValue)) {
    const conditions = exportValue as Record<string, unknown>;
    if ("import" in conditions && typeof conditions.import === "string") return conditions.import;
    if ("default" in conditions && typeof conditions.default === "string") return conditions.default;
  }
  return undefined;
}

// Resolves a bare or deep "@hoolypane/*" specifier by walking up from the runner installation,
// probing node_modules for the PACKAGE directory only. Root imports keep the src/index.ts dev
// shortcut; subpath imports must be mapped by the package's exports field — pattern keys ("./x/*")
// and exports-less legacy layouts report a clear error instead of a silent index.js guess.
function hoolypaneEntry(specifier: string): string {
  const { packageName, packageSubpath } = splitHoolypaneSpecifier(specifier);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const packageDir = join(dir, "node_modules", packageName);
    const manifestPath = join(packageDir, "package.json");
    if (existsSync(manifestPath)) {
      if (packageSubpath === ".") {
        const sourceEntry = join(packageDir, "src", "index.ts");
        if (existsSync(sourceEntry)) return sourceEntry;
      }
      let manifest: unknown;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch (error) {
        throw new Error(`Cannot resolve ${specifier}: ${manifestPath} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
      }
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error(`Cannot resolve ${specifier}: ${manifestPath} is not a valid package manifest`);
      const manifestRecord = manifest as Record<string, unknown>; // JSON boundary; null/array/non-object rejected above.
      const exportsField: unknown = manifestRecord.exports;
      const exportTable: Record<string, unknown> | undefined = exportsField && typeof exportsField === "object" && !Array.isArray(exportsField)
        ? exportsField as Record<string, unknown> // keys are arbitrary specifiers by contract.
        : undefined;
      const target = exportTarget(exportTable?.[packageSubpath])
        ?? (packageSubpath === "." && typeof manifestRecord.main === "string" ? manifestRecord.main : undefined);
      if (target !== undefined) return join(packageDir, target);
      throw new Error(`Cannot resolve ${specifier}: ${manifestPath} does not expose "${packageSubpath}" through its exports field`);
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
// from the playwright package's real location. createRequire locates each specifier through Node's own
// resolver, but its "require" condition returns CJS entries whose re-export chain cjs-module-lexer
// cannot statically see — `import { chromium }` in the artifact would fail. So walk up to the package
// root and pick the "import"-condition entry (ESM) explicitly; bare-string export targets serve every
// condition and are therefore already covered by the CJS path. Deep specifiers ("playwright/test")
// resolve their own exports entry the same way against the runner-pinned copy.
function playwrightEntry(specifier: string): string {
  const requireFromRunner = createRequire(import.meta.url);
  let directResolveFailed = false;
  let located: string;
  try {
    located = requireFromRunner.resolve(specifier);
  } catch {
    // The subpath may be gated away from the "require" condition; anchor on the package root and let
    // the exports table decide below.
    directResolveFailed = true;
    located = requireFromRunner.resolve("playwright");
  }
  const subpath = specifier === "playwright" ? "." : `./${specifier.slice("playwright/".length)}`;
  // Without a directly resolved file there is no honest fallback: degrade() refuses instead of
  // pointing the artifact at an unrelated entry.
  const degrade = (): string => {
    if (!directResolveFailed) return located;
    throw new Error(`Cannot resolve ${specifier}: the runner-pinned playwright install does not export "${subpath}"`);
  };
  let dir = dirname(located);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) break;
    const parent = dirname(dir);
    if (parent === dir) return degrade();
    dir = parent;
  }
  const manifestPath = join(dir, "package.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    if (directResolveFailed) throw new Error(`Cannot resolve ${specifier}: ${manifestPath} is not valid JSON`);
    return located;
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    if (directResolveFailed) throw new Error(`Cannot resolve ${specifier}: ${manifestPath} is not a valid package manifest`);
    return located;
  }
  // JSON boundary: member reads below are guarded by in-checks on this record.
  const manifestRecord = manifest as Record<string, unknown>;
  if (!("name" in manifestRecord) || manifestRecord.name !== "playwright") return degrade();
  if (!("exports" in manifestRecord)) return degrade();
  const exportTable: unknown = manifestRecord.exports;
  if (typeof exportTable !== "object" || exportTable === null || Array.isArray(exportTable)) return degrade();
  // Same JSON boundary as above for the exports table.
  const exportRecord = exportTable as Record<string, unknown>;
  if (!(subpath in exportRecord)) return degrade();
  const exportValue: unknown = exportRecord[subpath];
  if (exportValue === null || typeof exportValue !== "object" || Array.isArray(exportValue)) return located;
  // Conditional map object: guarded member access via in-narrowing.
  const conditions = exportValue as Record<string, unknown>;
  const target: unknown = "import" in conditions ? conditions.import : "default" in conditions ? conditions.default : undefined;
  return typeof target === "string" ? join(dir, target) : located;
}

// Emits playwright's ESM entry as an absolute file-URL specifier so Node loads the real ESM file
// (named exports intact) while esbuild keeps it out of the bundle. An absolute URL is immune to
// symlink canonicalization: Node resolves the emitted specifier against the artifact's realpath,
// which diverges from the lexical cache path whenever /tmp, project roots, or volume mounts are
// symlinks — a module-relative "../" sequence would then point outside the playwright install.
function playwrightResolution(): Plugin {
  return {
    name: "playwright-resolution",
    setup(pluginBuild: PluginBuild): void {
      pluginBuild.onResolve({ filter: /^playwright(\/|$)/ }, (args) => {
        return { path: pathToFileURL(playwrightEntry(args.path)).href, external: true };
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
