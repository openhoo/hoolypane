// Single home for the Linux desktop runtime contracts shared between the
// integration harness (vitest/TS, imports "./desktop-runtime.js") and the
// plain-node root scripts (.mjs importing the exact ".ts" specifier — Node ≥24
// strips types natively): software-rendering flags/env, graceful child
// teardown, one capturing command runner, and fixture-server startup/readiness.
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Chromium flags forcing software rendering under Xvfb; previously hand-synced across four sites. */
export const LINUX_SOFTWARE_RENDERING_ARGS = ["--ozone-platform=x11", "--use-gl=angle", "--use-angle=swiftshader"];

/** Copies environment with LIBGL_ALWAYS_SOFTWARE forced on for Chromium's software GL path. */
export function applyLinuxSoftwareRenderingEnv(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...environment, LIBGL_ALWAYS_SOFTWARE: "1" };
}

/**
 * Graceful child teardown: SIGTERM, then SIGKILL after graceMs, resolving once the
 * child exits. Children that already terminated — by code OR signal — resolve
 * immediately instead of waiting forever.
 */
export async function stopChildProcess(child: ChildProcess | null | undefined, graceMs = 2_000): Promise<void> {
  if (!child) return;
  // Attach before the liveness check so an exit racing the check cannot hang the await below.
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const forceExitTimer = setTimeout(() => child.kill("SIGKILL"), graceMs);
  await exited;
  clearTimeout(forceExitTimer);
  // Release piped streams so short-lived scripts are not kept alive by open descriptors.
  child.stdout?.destroy();
  child.stderr?.destroy();
}

interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** "inherit" streams to the console; "capture" (default) collects combined stdout+stderr. */
  output?: "inherit" | "capture";
  /** Resolve with the captured output even on non-zero exit (capture mode); default rejects. */
  ignoreExitCode?: boolean;
  /** Win32 .cmd shims resolve only through cmd.exe; pass shell:true there when spawning shims. */
  shell?: boolean;
}

/** One spawn-and-await runner: capture mode resolves with combined output, inherit mode with "". */
export async function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<string> {
  const { cwd, env, output = "capture", ignoreExitCode = false, shell = false } = options;
  return await new Promise<string>((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: output === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
      shell,
    });
    let combined = "";
    child.stdout?.on("data", (chunk) => { combined += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { combined += chunk.toString(); });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0 || ignoreExitCode) {
        resolveRun(combined);
      } else if (output === "inherit") {
        rejectRun(new Error(`${command} ${args.join(" ")} exited ${code ?? signal}`));
      } else {
        rejectRun(new Error(`${command} exited ${code ?? signal}: ${combined}`));
      }
    });
  });
}

export interface FixtureServer {
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
  const ready = Promise.withResolvers<void>();
  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    if (text.includes("fixture ready")) ready.resolve();
  });
  child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
  child.once("error", ready.reject);
  child.once("exit", (code) => ready.reject(new Error(`fixture server failed before readiness (code ${code}): ${output.trim()}`)));
  await ready.promise;
  return {
    async close(): Promise<void> {
      await stopChildProcess(child);
    },
  };
}
