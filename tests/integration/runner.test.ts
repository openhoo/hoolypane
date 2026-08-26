import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFlow } from "../../packages/runner/src/run-flow.js";
import { pollUntil, startFixtureServer, type FixtureServer } from "../helpers/harness.js";
import { inlineConfigSource } from "../helpers/inline-config.js";
import { FIXTURE_PORTS, fixtureOrigin } from "../fixtures/ports.js";

const FIXTURE_PORT = FIXTURE_PORTS.runner;

let fixture: FixtureServer | undefined;
const outputs: string[] = [];

beforeAll(async () => {
  fixture = await startFixtureServer(FIXTURE_PORT);
}, 10_000);

afterAll(async () => {
  await fixture?.close();
  await Promise.all(outputs.map((output) => rm(output, { recursive: true, force: true })));
}, 30_000);

async function outputDirectory(name: string): Promise<string> {
  const output = await mkdtemp(join(tmpdir(), `hoolypane-${name}-`));
  outputs.push(output);
  return output;
}

async function results(): Promise<unknown[]> {
  return fetch(`${fixtureOrigin(FIXTURE_PORT)}/results`).then((response) => response.json()) as Promise<unknown[]>;
}

async function waitForRecorderState(output: string, expected: string): Promise<void> {
  // External child process exposes readiness only through its atomically written state file.
  await pollUntil(async () => {
    try {
      const state = JSON.parse(await readFile(join(output, "run-state.json"), "utf8")) as { state?: string };
      return state.state === expected;
    } catch {
      return null; // recorder has not created state yet
    }
  }, 10_000, 10);
}

describe("real runner", () => {
  it("executes every action in isolated responsive contexts and records aligned artifacts", async () => {
    await fetch(`${fixtureOrigin(FIXTURE_PORT)}/reset`);
    const output = await outputDirectory("success");
    const result = await runFlow({ flowFile: resolve("tests/fixtures/responsive.flow.ts"), configFile: resolve("tests/fixtures/hoolypane.config.ts"), outputDir: output, headed: false });
    if (result.status !== "success") {
      // Surface the per-viewport failure reasons recorded in the manifest instead of failing opaque.
      const diagnostics = await readFile(join(output, "manifest.json"), "utf8").then(JSON.parse).catch(() => null);
      console.log("RUNNER FLOW FAILURES", JSON.stringify((diagnostics as { failures?: unknown })?.failures ?? diagnostics)?.slice(0, 4000));
    }
    expect(result.status).toBe("success");
    const observed = await results() as Array<Record<string, unknown>>;
    expect(observed.map(({ id }) => id).sort()).toEqual(["desktop", "phone", "tablet"]);
    for (const state of observed) expect(state).toMatchObject({ name: "Hoolypane", theme: "dark", subscribed: true, status: "entered", scrollRatio: 1 });
    for (const id of ["desktop", "tablet", "phone"]) await expect(stat(join(output, "traces", `${id}.zip`))).resolves.toBeDefined();
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8")) as { contract: string; validationSuccess: boolean; durationFrames: number };
    expect(manifest).toMatchObject({ contract: "multi-viewport-cfr-v1", validationSuccess: true });
    expect(manifest.durationFrames).toBeGreaterThan(0);
    // Full flow incl. six-figure fixture page, recording and ffmpeg encode; 60s was too tight on CI runners.
  }, 120_000);

  it("reports every viewport affected by a failed barrier", async () => {
    const output = await outputDirectory("failure");
    const result = await runFlow({ flowFile: resolve("tests/fixtures/failing.flow.ts"), configFile: resolve("tests/fixtures/hoolypane.config.ts"), outputDir: output, headed: false });
    expect(result.status).toBe("failed");
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8")) as { failures: Array<{ message: string }> };
    // Match by content instead of index: runFlow() lists trace-stop failures ahead of the flow
    // failure, so the barrier entry's array position is incidental.
    const barrierMessage = manifest.failures.map((failure) => failure.message).find((message) => ["desktop", "tablet", "phone"].every((viewport) => message.includes(viewport)));
    expect(barrierMessage).toBeDefined();
  }, 60_000);

  it("SIGINT after T0 produces a validated aligned partial run", async () => {
    const output = await outputDirectory("interrupt");
    const child = spawn(process.execPath, [
      resolve("packages/runner/dist/cli.js"),
      "run",
      resolve("tests/fixtures/slow.flow.ts"),
      "--config",
      resolve("tests/fixtures/hoolypane.config.ts"),
      "--output",
      output,
    ], { stdio: ["ignore", "ignore", "inherit"] });
    const exited = Promise.withResolvers<number | null>();
    child.once("error", exited.reject);
    child.once("exit", (code) => exited.resolve(code));
    try {
      await waitForRecorderState(output, "recording");
      // Windows terminates SIGINT-signalled children unconditionally with exit code 1; only POSIX honours 130.
      child.kill("SIGINT");
      const exitCode = await exited.promise;
      if (process.platform === "win32") expect(exitCode).toBe(1);
      else expect(exitCode).toBe(130);
    } finally {
      // kill() flips `killed` synchronously even while the child keeps running, so
      // escalate whenever neither an exit code nor a fatal signal was observed yet.
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited.promise.catch(() => undefined);
    }
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8")) as { status: string; validationSuccess: boolean; durationFrames: number };
    expect(manifest).toMatchObject({ status: "interrupted", validationSuccess: true });
    expect(manifest.durationFrames).toBeGreaterThan(0);
  }, 30_000);

  it("fails a flow that exceeds timeoutMs with the exact timeout failure", async () => {
    const output = await outputDirectory("timeout");
    const scratch = await outputDirectory("timeout-config");
    const timeoutMs = 5_000;
    // Inline config written beside (never inside) the wiped output directory; slow.flow waits 30s, so a
    // 5s deadline trips the timeout branch deterministically (the timer starts only after initial frames).
    const configPath = join(scratch, "hoolypane.config.ts");
    await writeFile(configPath, inlineConfigSource(fixtureOrigin(FIXTURE_PORT), [{ id: "desktop", name: "Desktop", width: 320, height: 240, deviceScaleFactor: 1, isMobile: false, hasTouch: false }], timeoutMs));
    const result = await runFlow({ flowFile: resolve("tests/fixtures/slow.flow.ts"), configFile: configPath, outputDir: output, headed: false });
    expect(result.status).toBe("failed");
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8")) as { status: string; failures: Array<{ message: string }> };
    expect(manifest.status).toBe("failed");
    // Content-matched rather than index-matched, consistent with the barrier test above.
    expect(manifest.failures.map((failure) => failure.message)).toContain(`flow timed out after ${timeoutMs}ms`);
  }, 60_000);
});
