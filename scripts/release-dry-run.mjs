import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
function run(command, args, environment = process.env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: environment,
      // .cmd shims on Windows only resolve through cmd.exe; args are fixed literals.
      shell: process.platform === "win32",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code ?? signal}`)));
  });
}

// Captures combined output regardless of exit code, mirroring the workflow's "$(npx ... || true)".
function capture(command, args, cwd) {
  return new Promise((resolveCapture, rejectCapture) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: process.platform === "win32",
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", rejectCapture);
    child.once("exit", () => resolveCapture(output));
  });
}

await run(pnpm, ["pins:check"]);
await run(pnpm, ["architecture"]);
await run(pnpm, ["exec", "knip"]);
await run(pnpm, ["typecheck"]);
await run(pnpm, ["test:unit"]);
await run(pnpm, ["test:runner"]);
await run(pnpm, ["prepare:electron"]);
await run(pnpm, ["build"]);
if (process.platform === "linux") {
  const environment = { ...process.env, LIBGL_ALWAYS_SOFTWARE: "1" };
  delete environment.DBUS_SESSION_BUS_ADDRESS;
  delete environment.WAYLAND_DISPLAY;
  // Explicit screen geometry: xvfb-run's default 640x480 clamps the Electron window below its
  // minimum, shrinking masonry seeds until native drag input hits the wrong card (documented
  // phantom-drag failure mode). The same args are used everywhere desktop E2E runs locally.
  const xvfb = ["--", "xvfb-run", "-a", "--server-args=-screen 0 1920x1080x24"];
  await run("dbus-run-session", [...xvfb, pnpm, "test:desktop"], environment);
  await run("dbus-run-session", [...xvfb, pnpm, "benchmark:desktop"], environment);
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
const packageScript = process.platform === "win32" ? "package:windows" : process.platform === "darwin" ? "package:mac" : "package:linux";
await run(pnpm, [packageScript]);
if (process.platform === "linux") {
  const environment = { ...process.env, LIBGL_ALWAYS_SOFTWARE: "1" };
  delete environment.DBUS_SESSION_BUS_ADDRESS;
  delete environment.WAYLAND_DISPLAY;
  await run("dbus-run-session", ["--", "xvfb-run", "-a", "--server-args=-screen 0 1920x1080x24", pnpm, "smoke:desktop-package", "--", "dist/desktop"], environment);
} else {
  await run(pnpm, ["smoke:desktop-package", "--", "dist/desktop"]);
}
process.stdout.write("RELEASE_DRY_RUN_OK\n");
