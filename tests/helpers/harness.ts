import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { electronExecutablePath } from "../electron-executable.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Polls fn until it returns a truthy value or the timeout elapses. */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  intervalMs = 20,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let latest: T | undefined;
  while (Date.now() < deadline) {
    latest = await fn();
    if (latest !== null && latest !== undefined && latest !== false) return latest as NonNullable<T>;
    await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, intervalMs));
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
}

export interface FixtureServer {
  readonly child: ChildProcess;
  readonly port: number;
  /** Terminates the fixture promptly even when Chromium panes keep keep-alive sockets open. */
  close(): Promise<void>;
}

/**
 * Spawns tests/fixtures/server.mjs and resolves once it reports readiness.
 * The child's stdout/stderr are piped so startup errors (e.g. EADDRINUSE) surface
 * in failure messages instead of being discarded.
 */
export async function startFixtureServer(port: number): Promise<FixtureServer> {
  const child = spawn(process.execPath, [resolve(REPO_ROOT, "tests/fixtures/server.mjs")], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const ready = Promise.withResolvers<void>();
  child.stdout?.on("data", (data: Buffer) => {
    if (data.toString().includes("fixture ready")) ready.resolve();
  });
  child.once("error", ready.reject);
  child.once("exit", (code) => ready.reject(new Error(`fixture server failed before readiness (code ${code}): ${output.trim()}`)));
  await ready.promise;
  return {
    child,
    port,
    async close(): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = Promise.withResolvers<void>();
      child.once("exit", () => exited.resolve());
      child.kill("SIGTERM");
      const forceExitTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      await exited.promise;
      clearTimeout(forceExitTimer);
    },
  };
}

interface DesktopLaunch {
  readonly application: ElectronApplication;
  readonly chrome: Page;
  /** Temporary directory backing the app profile; remove it during teardown. */
  readonly userDataDir: string;
}

interface LaunchDesktopAppOptions {
  /** Port of an already-running tests/fixtures/server.mjs instance. */
  port: number;
  /** App-profile base directory; a fresh temporary one is created when omitted. */
  userDataDir?: string;
  /** Extra environment variables merged over the filtered parent environment. */
  extraEnv?: Readonly<Record<string, string>>;
}

/**
 * Launches the desktop app against the given fixture URL with the shared
 * graphics/env setup used by every integration suite, then returns its chrome window.
 */
export async function launchDesktopApp(options: LaunchDesktopAppOptions): Promise<DesktopLaunch> {
  const userDataDir = options.userDataDir ?? await mkdtemp(join(tmpdir(), "hoolypane-test-"));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  Object.assign(environment, options.extraEnv);
  if (process.platform === "linux") {
    environment.XDG_SESSION_TYPE = "x11";
    delete environment.WAYLAND_DISPLAY;
  }
  const graphicsArguments =
    process.platform === "linux" ? ["--ozone-platform=x11", "--use-gl=angle", "--use-angle=swiftshader"] : [];
  const application = await electron.launch({
    executablePath: electronExecutablePath(),
    args: [
      ...graphicsArguments,
      resolve(REPO_ROOT, "apps/desktop"),
      `--user-data-dir=${join(userDataDir, "user-data")}`,
      "--url",
      `http://127.0.0.1:${options.port}`,
    ],
    env: environment,
  });
  const chrome = await application.firstWindow();
  return { application, chrome, userDataDir };
}
