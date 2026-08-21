import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFlow } from "../../packages/runner/src/run-flow.js";

let fixture: ChildProcess;
const outputs: string[] = [];

beforeAll(async () => {
  fixture = spawn(process.execPath, [resolve("tests/fixtures/server.mjs")], { env: { ...process.env, PORT: "4174" }, stdio: ["ignore", "pipe", "inherit"] });
  const ready = Promise.withResolvers<void>();
  fixture.stdout?.on("data", (data: Buffer) => { if (data.toString().includes("fixture ready")) ready.resolve(); });
  fixture.once("error", ready.reject);
  await ready.promise;
}, 10_000);

afterAll(async () => {
  fixture.kill("SIGTERM");
  await Promise.all(outputs.map((output) => rm(output, { recursive: true, force: true })));
});

async function outputDirectory(name: string): Promise<string> {
  const output = await mkdtemp(join(tmpdir(), `hoolypane-${name}-`));
  outputs.push(output);
  return output;
}

async function results(): Promise<unknown[]> {
  return fetch("http://127.0.0.1:4174/results").then((response) => response.json()) as Promise<unknown[]>;
}
async function waitForRecorderState(output: string, expected: string): Promise<void> {
  // External child process exposes readiness only through its atomically written state file.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(join(output, "run-state.json"), "utf8")) as { state?: string };
      if (state.state === expected) return;
    } catch { /* recorder has not created state yet */ }
    const next = Promise.withResolvers<void>();
    setTimeout(next.resolve, 10);
    await next.promise;
  }
  throw new Error(`recorder did not reach ${expected}`);
}

describe("real runner", () => {
  it("executes every action in isolated responsive contexts and records aligned artifacts", async () => {
    await fetch("http://127.0.0.1:4174/reset");
    const output = await outputDirectory("success");
    const result = await runFlow({ command: "run", flowFile: resolve("tests/fixtures/responsive.flow.ts"), configFile: resolve("tests/fixtures/hoolypane.config.ts"), outputDir: output, headed: false });
    expect(result.status).toBe("success");
    const observed = await results() as Array<Record<string, unknown>>;
    expect(observed.map(({ id }) => id).sort()).toEqual(["desktop", "phone", "tablet"]);
    for (const state of observed) expect(state).toMatchObject({ name: "Hoolypane", theme: "dark", subscribed: true, status: "entered", scrollRatio: 1 });
    for (const id of ["desktop", "tablet", "phone"]) await expect(stat(join(output, "traces", `${id}.zip`))).resolves.toBeDefined();
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8")) as { contract: string; validationSuccess: boolean; durationFrames: number };
    expect(manifest).toMatchObject({ contract: "multi-viewport-cfr-v1", validationSuccess: true });
    expect(manifest.durationFrames).toBeGreaterThan(0);
  }, 60_000);

  it("reports every viewport affected by a failed barrier", async () => {
    const output = await outputDirectory("failure");
    const result = await runFlow({ command: "run", flowFile: resolve("tests/fixtures/failing.flow.ts"), configFile: resolve("tests/fixtures/hoolypane.config.ts"), outputDir: output, headed: false });
    expect(result.status).toBe("failed");
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8")) as { failures: Array<{ message: string }> };
    expect(manifest.failures[0]?.message).toMatch(/desktop/);
    expect(manifest.failures[0]?.message).toMatch(/tablet/);
    expect(manifest.failures[0]?.message).toMatch(/phone/);
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
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const exited = Promise.withResolvers<number | null>();
    child.once("error", exited.reject);
    child.once("exit", (code) => exited.resolve(code));
    await waitForRecorderState(output, "recording");
    child.kill("SIGINT");
    expect(await exited.promise).toBe(130);
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8")) as { status: string; validationSuccess: boolean; durationFrames: number };
    expect(manifest).toMatchObject({ status: "interrupted", validationSuccess: true });
    expect(manifest.durationFrames).toBeGreaterThan(0);
  }, 30_000);
});
