import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// Node strips types natively; plain-node scripts need the exact .ts specifier.
import { runCommand } from "../tests/helpers/desktop-runtime.ts";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

// Local adapters over the shared runner in tests/helpers/desktop-runtime.ts: gates stream live
// output while the consumer --help probe captures regardless of exit code. Win32 .cmd shims
// (pnpm.cmd/npm.cmd/npx.cmd) resolve only through cmd.exe; args stay fixed literals, which is
// why smoke-desktop-package.mjs intentionally stays shell-less for its direct .exe spawns.
const winShell = process.platform === "win32";
const run = (command, args, environment = process.env, cwd) =>
  runCommand(command, args, { env: environment, cwd, output: "inherit", shell: winShell });

// Captures combined output regardless of exit code, mirroring the workflow's "$(npx ... || true)".
const capture = (command, args, cwd) =>
  runCommand(command, args, { cwd, shell: winShell, ignoreExitCode: true });

await run(pnpm, ["pins:check"]);
await run(pnpm, ["architecture"]);
await run(pnpm, ["exec", "knip"]);
await run(pnpm, ["typecheck"]);
await run(pnpm, ["test:unit"]);
await run(pnpm, ["test:runner"]);
await run(pnpm, ["prepare:electron"]);
await run(pnpm, ["build"]);
if (process.platform === "linux") {
  await run(pnpm, ["test:desktop:xvfb"]);
  await run(pnpm, ["benchmark:desktop:xvfb"]);
} else {
  await run(pnpm, ["test:desktop"]);
  await run(pnpm, ["benchmark:desktop"]);
}
await run(pnpm, ["benchmark:recording"]);
// Artifact hygiene: drop runner tarballs left over from earlier runs so the consumer
// smoke below can only install the archive pack:runner just wrote.
for (const entry of await readdir("dist").catch(() => [])) {
  if (/^hoolypane-runner-.+\.tgz$/.test(entry)) await rm(resolve("dist", entry));
}
await run(pnpm, ["pack:runner"]);

// Consumer-side smoke of the packed runner tarball: mirrors the release workflow's
// clean-project install plus CLI help assertion, so a broken package fails here
// instead of wasting a tagged three-OS release run.
const runnerTarball = (await readdir("dist")).find((entry) => /^hoolypane-runner-.+\.tgz$/.test(entry));
if (!runnerTarball) throw new Error("pack:runner produced no dist/hoolypane-runner-*.tgz");
const tarballPath = resolve("dist", runnerTarball);
const smokeProject = await mkdtemp(join(tmpdir(), "hoolypane-runner-smoke-"));
try {
  await writeFile(join(smokeProject, "package.json"), `${JSON.stringify({ name: "hoolypane-runner-smoke", private: true })}\n`);
  // Quoted for the win32 shell:true spawn path, which joins args verbatim.
  await run(npm, ["install", process.platform === "win32" ? `"${tarballPath}"` : tarballPath], process.env, smokeProject);
  const help = await capture(npx, ["hoolypane", "--help"], smokeProject);
  const usageAt = help.indexOf("Usage: hoolypane <command>");
  const runUsageAt = help.indexOf("run <flow-file>");
  if (usageAt === -1 || runUsageAt === -1 || runUsageAt < usageAt) {
    throw new Error(`packed runner --help output does not match the CLI contract:\n${help}`);
  }
} finally {
  await rm(smokeProject, { recursive: true, force: true });
}
// Artifact hygiene: drop stale installer outputs from earlier runs/versions so
// smoke:desktop-package's soleArtifact check only sees what package:* just wrote
// (electron-builder never deletes previous version/arch artifacts).
for (const entry of await readdir("dist/desktop").catch(() => [])) {
  if (/^Hoolypane[-_].+\.(AppImage|exe|dmg|deb)$/.test(entry)) await rm(resolve("dist/desktop", entry));
}
const packageScript = process.platform === "win32" ? "package:windows" : process.platform === "darwin" ? "package:mac" : "package:linux";
await run(pnpm, [packageScript]);
if (process.platform === "linux") {
  await run(pnpm, ["smoke:desktop-package:xvfb", "--", "dist/desktop"]);
} else {
  await run(pnpm, ["smoke:desktop-package", "--", "dist/desktop"]);
}
process.stdout.write("RELEASE_DRY_RUN_OK\n");
