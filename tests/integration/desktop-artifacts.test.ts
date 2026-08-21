import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFlow } from "../../packages/runner/src/run-flow.js";

import { electronExecutablePath } from "../electron-executable.js";
let fixture: ChildProcess;
let application: ElectronApplication;
let chrome: Page;
let directory = "";
let panePng = "";
let overviewPng = "";
let errorOverviewPng = "";
let flowPath = "";

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { await access(path); return; } catch { /* writer not finished */ }
    const next = Promise.withResolvers<void>();
    setTimeout(next.resolve, 20);
    await next.promise;
  }
  throw new Error(`artifact was not written: ${path}`);
}

async function waitForPanes(expected: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const count = await application.evaluate(({ webContents }) => webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith("http://127.0.0.1:4178")).length);
    if (count === expected) return;
    const next = Promise.withResolvers<void>();
    setTimeout(next.resolve, 20);
    await next.promise;
  }
  throw new Error(`desktop did not reach ${expected} panes`);
}

async function clickDesktopApply(): Promise<void> {
  const surface = await chrome.locator('[data-pane-surface="desktop-1440"]').boundingBox();
  if (!surface) throw new Error("desktop source surface missing");
  const viewport = await chrome.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const visibleWidth = Math.max(0, Math.min(viewport.width, surface.x + surface.width) - Math.max(0, surface.x));
  const visibleHeight = Math.max(0, Math.min(viewport.height, surface.y + surface.height) - Math.max(0, surface.y));
  const scale = Math.min(1, visibleWidth / 1440, visibleHeight / 900);
  const result = await application.evaluate(async ({ webContents }, inputScale) => {
    const candidates = webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith("http://127.0.0.1:4178"));
    let source: (typeof candidates)[number] | undefined;
    for (const candidate of candidates) {
      if (await candidate.executeJavaScript("innerWidth") === 1440) { source = candidate; break; }
    }
    if (!source) throw new Error("desktop source pane missing");
    const box = await source.executeJavaScript(`document.querySelector('[data-testid=\"apply\"]').getBoundingClientRect().toJSON()`);
    const x = (box.x + box.width / 2) * inputScale;
    const y = (box.y + box.height / 2) * inputScale;
    await source.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await source.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    return { box, x, y, status: await source.executeJavaScript(`document.querySelector('[data-testid=\"status\"]').textContent`) };
  }, scale);
  if (result.status !== "applied") throw new Error(`source Apply click did not activate: ${JSON.stringify({ surface, scale, result })}`);
}

async function waitForAppliedCount(expected: number): Promise<void> {
  let latest = -1;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const count = await fetch("http://127.0.0.1:4178/applied-count").then((response) => response.json()).then((value) => value.count);
    latest = count;
    if (count === expected) return;
    const next = Promise.withResolvers<void>();
    setTimeout(next.resolve, 20);
    await next.promise;
  }
  throw new Error(`fixture did not observe ${expected} applied actions; latest=${latest}`);
}

beforeAll(async () => {
  fixture = spawn(process.execPath, [resolve("tests/fixtures/server.mjs")], { env: { ...process.env, PORT: "4178" }, stdio: ["ignore", "pipe", "inherit"] });
  const ready = Promise.withResolvers<void>();
  fixture.stdout?.on("data", (data: Buffer) => { if (data.toString().includes("fixture ready")) ready.resolve(); });
  fixture.once("error", ready.reject);
  await ready.promise;
  directory = await mkdtemp(join(tmpdir(), "hoolypane-artifacts-"));
  panePng = join(directory, "pane.png");
  overviewPng = join(directory, "overview.png");
  errorOverviewPng = join(directory, "overview-error.png");
  flowPath = join(directory, "recorded.flow.ts");
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  Object.assign(environment, {
    HOOLYPANE_TEST_MODE: "1",
    HOOLYPANE_TEST_PANE_PNG: panePng,
    HOOLYPANE_TEST_OVERVIEW_PNG: overviewPng,
    HOOLYPANE_TEST_FLOW_PATH: flowPath,
  });
  if (process.platform === "linux") {
    environment.XDG_SESSION_TYPE = "x11";
    delete environment.WAYLAND_DISPLAY;
  }
  const graphicsArguments = process.platform === "linux" ? ["--ozone-platform=x11", "--use-gl=angle", "--use-angle=swiftshader"] : [];
  const electronExecutable = electronExecutablePath();
  application = await electron.launch({ executablePath: electronExecutable, args: [...graphicsArguments, resolve("apps/desktop"), `--user-data-dir=${join(directory, "user-data")}`, "--url", "http://127.0.0.1:4178"], env: environment });
  chrome = await application.firstWindow();
  await waitForPanes(5);
}, 30_000);

afterAll(async () => {
  await application?.close().catch(() => undefined);
  fixture?.kill("SIGTERM");
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("desktop screenshots and recorded flows", () => {
  it("exports stills, preserves good overview tiles, and runs the recorded flow", async () => {
    await chrome.getByRole("button", { name: "Save PNG" }).first().click();
    await waitForFile(panePng);
    expect(await sharp(panePng).metadata()).toMatchObject({ format: "png" });

    await chrome.getByRole("button", { name: "Save Overview PNG" }).click();
    await waitForFile(overviewPng);
    const goodOverview = await readFile(overviewPng);
    expect((await sharp(goodOverview).metadata()).width).toBeGreaterThan(500);

    await chrome.getByRole("button", { name: "Start Flow Recording" }).click();
    await chrome.getByRole("button", { name: "Stop Flow Recording" }).waitFor({ state: "visible" });
    await chrome.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await clickDesktopApply();
    await waitForAppliedCount(5);
    await chrome.getByRole("button", { name: "Stop Flow Recording" }).click();
    await chrome.getByRole("button", { name: "Start Flow Recording" }).waitFor({ state: "visible" });
    await waitForFile(flowPath);
    const flowSource = await readFile(flowPath, "utf8");
    expect(flowSource).toContain('import { defineFlow } from "@hoolypane/runner";');
    expect(flowSource).toContain("getByTestId(\"apply\").click()");

    await fetch("http://127.0.0.1:4178/reset");
    const configPath = join(directory, "hoolypane.config.ts");
    await writeFile(configPath, `import { defineConfig } from "@hoolypane/runner"; export default defineConfig({ baseURL: "http://127.0.0.1:4178", viewports: [{ id: "one", name: "One", width: 320, height: 240, deviceScaleFactor: 1, isMobile: false, hasTouch: false }, { id: "two", name: "Two", width: 180, height: 320, deviceScaleFactor: 1, isMobile: true, hasTouch: true }], recording: { fps: 30, compositeMaxSize: { width: 640, height: 480 } } });`);
    const runOutput = join(directory, "runner-output");
    const run = await runFlow({ command: "run", flowFile: flowPath, configFile: configPath, outputDir: runOutput, headed: false });
    expect(run.status).toBe("success");
    await waitForAppliedCount(2);

    const emptyPath = join(directory, "empty.flow.ts");
    await application.evaluate((_electron, path) => { process.env.HOOLYPANE_TEST_FLOW_PATH = path; delete process.env.HOOLYPANE_TEST_FLOW_SAVE_CANCEL; }, emptyPath);
    await chrome.getByRole("button", { name: "Start Flow Recording" }).click();
    await chrome.getByRole("button", { name: "Stop Flow Recording" }).waitFor({ state: "visible" });
    await chrome.getByRole("button", { name: "Stop Flow Recording" }).click();
    await chrome.getByRole("button", { name: "Start Flow Recording" }).waitFor({ state: "visible" });
    await expect(access(emptyPath)).rejects.toBeDefined();

    const canceledPath = join(directory, "canceled.flow.ts");
    await application.evaluate((_electron, path) => { process.env.HOOLYPANE_TEST_FLOW_PATH = path; process.env.HOOLYPANE_TEST_FLOW_SAVE_CANCEL = "1"; }, canceledPath);
    await chrome.getByRole("button", { name: "Start Flow Recording" }).click();
    await chrome.getByRole("button", { name: "Stop Flow Recording" }).waitFor({ state: "visible" });
    await chrome.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await clickDesktopApply();
    await waitForAppliedCount(7);
    await chrome.getByRole("button", { name: "Stop Flow Recording" }).click();
    await chrome.getByRole("button", { name: "Start Flow Recording" }).waitFor({ state: "visible" });
    await expect(access(canceledPath)).rejects.toBeDefined();

    await application.evaluate((_electron, path) => { process.env.HOOLYPANE_TEST_OVERVIEW_PNG = path; delete process.env.HOOLYPANE_TEST_FLOW_SAVE_CANCEL; }, errorOverviewPng);
    await application.evaluate(({ webContents }) => {
      const pane = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith("http://127.0.0.1:4178"));
      pane?.close({ waitForBeforeUnload: false });
    });
    await chrome.getByRole("button", { name: "Save Overview PNG" }).click();
    await waitForFile(errorOverviewPng);
    const errorPixels = await sharp(errorOverviewPng).ensureAlpha().raw().toBuffer();
    let errorBackgroundPixels = 0;
    for (let offset = 0; offset < errorPixels.length; offset += 4) if (errorPixels[offset] === 58 && errorPixels[offset + 1] === 23 && errorPixels[offset + 2] === 27) errorBackgroundPixels += 1;
    expect(errorBackgroundPixels).toBeGreaterThan(1_000);
    expect(await readFile(errorOverviewPng)).not.toEqual(goodOverview);
  }, 90_000);
});
