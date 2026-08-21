import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let fixture: ChildProcess;
let application: ElectronApplication;
let userData = "";
async function waitForPaneCount(expected: number): Promise<void> {
  // Electron exposes native child-view readiness only through its WebContents registry.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const count = await application.evaluate(({ webContents }) => webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith("http://127.0.0.1:4177")).length);
    if (count === expected) return;
    const next = Promise.withResolvers<void>();
    setTimeout(next.resolve, 20);
    await next.promise;
  }
  throw new Error(`benchmark did not reach ${expected} panes`);
}

beforeAll(async () => {
  fixture = spawn(process.execPath, [resolve("tests/fixtures/server.mjs")], { env: { ...process.env, PORT: "4177" }, stdio: ["ignore", "pipe", "inherit"] });
  const ready = Promise.withResolvers<void>();
  fixture.stdout?.on("data", (data: Buffer) => { if (data.toString().includes("fixture ready")) ready.resolve(); });
  fixture.once("error", ready.reject);
  await ready.promise;
  userData = await mkdtemp(join(tmpdir(), "hoolypane-benchmark-"));
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  if (process.platform === "linux") environment.XDG_SESSION_TYPE = "x11";
  if (process.platform === "linux") delete environment.WAYLAND_DISPLAY;
  const graphicsArguments = process.platform === "linux" ? ["--ozone-platform=x11", "--use-gl=angle", "--use-angle=swiftshader"] : [];
  const electronExecutable = resolve(`apps/desktop/node_modules/electron/dist/electron${process.platform === "win32" ? ".exe" : ""}`);
  application = await electron.launch({
    executablePath: electronExecutable,
    args: [...graphicsArguments, resolve("apps/desktop"), `--user-data-dir=${userData}`, "--url", "http://127.0.0.1:4177"],
    env: environment,
  });
}, 30_000);

afterAll(async () => {
  await application?.close().catch(() => undefined);
  fixture?.kill("SIGTERM");
  if (userData) await rm(userData, { recursive: true, force: true });
});

describe("six-pane direct compositor", () => {
  it("keeps visible animation intervals within the release gate", async () => {
    const chrome = await application.firstWindow();
    await chrome.getByRole("button", { name: "Add custom" }).click();
    await waitForPaneCount(6);
    const measurements = await application.evaluate(async ({ webContents }) => {
      const panes = webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith("http://127.0.0.1:4177"));
      return Promise.all(panes.map((contents) => contents.executeJavaScript(`new Promise(resolve => { const values=[]; let previous=performance.now(); const frame=now=>{ values.push(now-previous); previous=now; if(values.length===1800){values.sort((a,b)=>a-b); resolve(values[Math.floor(values.length*0.95)]);}else requestAnimationFrame(frame)}; requestAnimationFrame(frame); })`)));
    });
    expect(measurements).toHaveLength(6);
    for (const p95 of measurements) expect(p95).toBeLessThanOrEqual(20);
  }, 60_000);
});
