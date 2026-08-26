import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
// Node 24 strips types natively; plain-node scripts need the exact .ts specifier (no .js remap).
import { FIXTURE_PORTS, fixtureOrigin } from "../tests/fixtures/ports.ts";
import {
  LINUX_SOFTWARE_RENDERING_ARGS,
  applyLinuxSoftwareRenderingEnv,
  runCommand,
  startFixtureServer,
  stopChildProcess,
} from "../tests/helpers/desktop-runtime.ts";

const directoryArgument = process.argv[2] === "--" ? process.argv[3] : process.argv[2];
const artifactDir = resolve(directoryArgument ?? "dist/desktop");
const files = await fs.readdir(artifactDir);
let temporary;
let debuggingPort;
const fixturePort = FIXTURE_PORTS.packageSmoke;
let mountedDmg;
let installedDirectory;
let app;
let fixture;
let appExit;
let logs = "";

function soleArtifact(extension) {
  const matches = files.filter((file) => file.endsWith(extension));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${extension} artifact in ${artifactDir}, found ${matches.length}: ${matches.join(", ") || "(none)"}`);
  }
  return matches[0];
}

async function waitForDesktop() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (appExit) throw new Error(`packaged desktop exited before readiness (${appExit.code ?? appExit.signal}): ${logs}`);
    try {
      const targets = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`, { signal: AbortSignal.timeout(2_000) }).then((response) => response.json());
      const fixtureTargets = targets.filter((target) => target.url === `${fixtureOrigin(fixturePort)}/`);
      if (targets.some((target) => target.url?.startsWith("file:") && target.title === "Hoolypane") && fixtureTargets.length >= 5) return;
    } catch { /* debugger not ready */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`packaged desktop did not expose five panes: ${logs}`);
}

try {
  temporary = await fs.mkdtemp(join(tmpdir(), "hoolypane-package-smoke-"));
  // Binds an OS-assigned port so concurrent runs and leaked predecessors cannot satisfy the probe.
  debuggingPort = await new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });

  fixture = await startFixtureServer(fixturePort);
  let executable;
  // Isolated user-data dir: without it the packaged app resolves userData from the host
  // profile, restores its saved panes, and persists fixture URLs into the real workspace.
  let launchArgs = [`--remote-debugging-port=${debuggingPort}`, `--user-data-dir=${join(temporary, "user-data")}`, "--url", fixtureOrigin(fixturePort)];
  let environment = { ...process.env };

  if (process.platform === "linux") {
    const artifact = soleArtifact(".AppImage");
    executable = join(artifactDir, artifact);
    await fs.chmod(executable, 0o755);
    environment = applyLinuxSoftwareRenderingEnv(environment);
    // Extraction mode cannot preserve the AppImage's setuid sandbox ownership; this flag is smoke-only.
    launchArgs = ["--appimage-extract-and-run", "--no-sandbox", ...LINUX_SOFTWARE_RENDERING_ARGS, ...launchArgs];
  } else if (process.platform === "win32") {
    const installer = soleArtifact(".exe");
    installedDirectory = join(temporary, "installed");
    if (/\s/.test(installedDirectory)) throw new Error(`NSIS /D= must be passed unquoted, so the install directory cannot contain whitespace, got: ${installedDirectory}`);
    await runCommand(join(artifactDir, installer), ["/S", `/D=${installedDirectory}`]);
    executable = join(installedDirectory, "Hoolypane.exe");
    await fs.access(executable);
  } else if (process.platform === "darwin") {
    const dmg = soleArtifact(".dmg");
    mountedDmg = join(temporary, "mounted");
    await fs.mkdir(mountedDmg);
    await runCommand("hdiutil", ["attach", join(artifactDir, dmg), "-nobrowse", "-readonly", "-mountpoint", mountedDmg]);
    executable = join(mountedDmg, "Hoolypane.app", "Contents", "MacOS", "Hoolypane");
    await fs.access(executable);
  } else {
    throw new Error(`unsupported smoke platform: ${process.platform}`);
  }

  app = spawn(executable, launchArgs, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  app.once("exit", (code, signal) => { appExit = { code, signal }; });
  // A failed spawn emits 'error' instead of 'exit'; record it so waitForDesktop reports
  // the failure through the normal path and the finally block can still tear down.
  app.once("error", (error) => {
    appExit = { code: null, signal: `spawn failed: ${String(error)}` };
    app.stdout?.destroy();
    app.stderr?.destroy();
    app = undefined;
  });
  app.stdout?.on("data", (data) => { logs += data; });
  app.stderr?.on("data", (data) => { logs += data; });
  await waitForDesktop();
  process.stdout.write(`PACKAGED_DESKTOP_SMOKE_OK ${basename(executable)}\n`);
} finally {
  await stopChildProcess(app);
  await fixture?.close();
  if (mountedDmg) await runCommand("hdiutil", ["detach", mountedDmg, "-force"]).catch(() => undefined);
  if (installedDirectory) {
    const uninstaller = join(installedDirectory, "Uninstall Hoolypane.exe");
    try { await runCommand(uninstaller, ["/S"]); } catch { /* temporary directory removal remains authoritative */ }
  }
  if (temporary) {
    try {
      await fs.rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch {
      // Best-effort: cleanup must never mask the primary failure.
    }
  }
}
