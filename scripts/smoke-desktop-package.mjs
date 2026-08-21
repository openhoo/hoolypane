import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const directoryArgument = process.argv[2] === "--" ? process.argv[3] : process.argv[2];
const artifactDir = resolve(directoryArgument ?? "dist/desktop");
const files = await fs.readdir(artifactDir);
const temporary = await fs.mkdtemp(join(tmpdir(), "hoolypane-package-smoke-"));
const fixturePort = 4188;
const debuggingPort = 9333;
let mountedDmg;
let installedDirectory;
let app;
let fixture;
let appExit;
let logs = "";

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let output = "";
    child.stdout?.on("data", (data) => { output += data; });
    child.stderr?.on("data", (data) => { output += data; });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolvePromise(output) : reject(new Error(`${command} exited ${code ?? signal}: ${output}`)));
  });
}
async function stopChild(child) {
  if (!child) return;
  if (child.exitCode === null) {
    const exited = Promise.withResolvers();
    child.once("exit", exited.resolve);
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    await exited.promise;
    clearTimeout(timer);
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function waitForFixture() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${fixturePort}/`)).ok) return; } catch { /* not ready */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("fixture server did not become ready");
}
async function waitForDesktop() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (appExit) throw new Error(`packaged desktop exited before readiness (${appExit.code ?? appExit.signal}): ${logs}`);
    try {
      const targets = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`).then((response) => response.json());
      const fixtureTargets = targets.filter((target) => target.url === `http://127.0.0.1:${fixturePort}/`);
      if (targets.some((target) => target.url?.startsWith("file:") && target.title === "Hoolypane") && fixtureTargets.length >= 5) return;
    } catch { /* debugger not ready */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`packaged desktop did not expose five panes: ${logs}`);
}

try {
  fixture = spawn(process.execPath, [resolve("tests/fixtures/server.mjs")], { env: { ...process.env, PORT: String(fixturePort) }, stdio: "ignore" });
  await waitForFixture();
  let executable;
  let launchArgs = [`--remote-debugging-port=${debuggingPort}`, "--url", `http://127.0.0.1:${fixturePort}`];
  let environment = { ...process.env };

  if (process.platform === "linux") {
    const artifact = files.find((file) => file.endsWith(".AppImage"));
    if (!artifact) throw new Error("Linux AppImage artifact missing");
    executable = join(artifactDir, artifact);
    await fs.chmod(executable, 0o755);
    environment = { ...environment, LIBGL_ALWAYS_SOFTWARE: environment.LIBGL_ALWAYS_SOFTWARE ?? "1" };
    // Extraction mode cannot preserve the AppImage's setuid sandbox ownership; this flag is smoke-only.
    launchArgs = ["--appimage-extract-and-run", "--no-sandbox", "--ozone-platform=x11", "--use-gl=angle", "--use-angle=swiftshader", ...launchArgs];
  } else if (process.platform === "win32") {
    const installer = files.find((file) => file.endsWith(".exe"));
    if (!installer) throw new Error("Windows NSIS artifact missing");
    installedDirectory = join(temporary, "installed");
    await run(join(artifactDir, installer), ["/S", `/D=${installedDirectory}`]);
    executable = join(installedDirectory, "Hoolypane.exe");
    await fs.access(executable);
  } else if (process.platform === "darwin") {
    const dmg = files.find((file) => file.endsWith(".dmg"));
    if (!dmg) throw new Error("macOS DMG artifact missing");
    mountedDmg = join(temporary, "mounted");
    await fs.mkdir(mountedDmg);
    await run("hdiutil", ["attach", join(artifactDir, dmg), "-nobrowse", "-readonly", "-mountpoint", mountedDmg]);
    executable = join(mountedDmg, "Hoolypane.app", "Contents", "MacOS", "Hoolypane");
    await fs.access(executable);
  } else {
    throw new Error(`unsupported smoke platform: ${process.platform}`);
  }

  app = spawn(executable, launchArgs, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  app.once("exit", (code, signal) => { appExit = { code, signal }; });
  app.stdout?.on("data", (data) => { logs += data; });
  app.stderr?.on("data", (data) => { logs += data; });
  await waitForDesktop();
  process.stdout.write(`PACKAGED_DESKTOP_SMOKE_OK ${basename(executable)}\n`);
} finally {
  await stopChild(app);
  await stopChild(fixture);
  if (mountedDmg) await run("hdiutil", ["detach", mountedDmg, "-force"]).catch(() => undefined);
  if (installedDirectory) {
    const uninstaller = join(installedDirectory, "Uninstall Hoolypane.exe");
    try { await run(uninstaller, ["/S"]); } catch { /* temporary directory removal remains authoritative */ }
  }
  await fs.rm(temporary, { recursive: true, force: true });
}
