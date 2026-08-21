import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { electronExecutablePath } from "../electron-executable.js";

const OUTPUT = resolve(process.env.HOOLYPANE_DESKTOP_BENCHMARK_OUTPUT ?? ".tmp/desktop-benchmark-proof.json");
const MIRROR_SAMPLES = 120;
const RAF_P95_LIMIT_MS = Number(process.env.HOOLYPANE_RAF_P95_LIMIT_MS ?? 20);
const FINAL_INPUT_UPDATES = 100;
let fixture: ChildProcess;
let application: ElectronApplication;
let userData = "";

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) throw new Error("cannot compute percentile of empty measurements");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))]!;
}

function remotePages(): Page[] {
  return application.context().pages().filter((page) => page.url().startsWith("http://127.0.0.1:4177"));
}

async function waitForPaneCount(expected: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const count = await application.evaluate(({ webContents }) => webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith("http://127.0.0.1:4177")).length);
    if (count === expected && remotePages().length === expected) return;
    const next = Promise.withResolvers<void>();
    setTimeout(next.resolve, 20);
    await next.promise;
  }
  throw new Error(`benchmark did not reach ${expected} panes`);
}

async function waitForMirrorCount(expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  let latest: number[] = [];
  while (Date.now() < deadline) {
    const counts = await Promise.all(remotePages().map((page) => page.evaluate(() => (globalThis as typeof globalThis & { __mirrorTimes?: number[] }).__mirrorTimes?.length ?? 0)));
    latest = counts;
    if (counts.length === 6 && counts.every((count) => count >= expected)) return;
    const next = Promise.withResolvers<void>();
    setTimeout(next.resolve, 5);
    await next.promise;
  }
  throw new Error(`mirrored click ${expected} did not reach all panes: ${JSON.stringify(latest)}`);
}

async function clickDesktopSource(chrome: Page): Promise<void> {
  const surface = await chrome.locator('[data-pane-surface="desktop-1440"]').boundingBox();
  if (!surface) throw new Error("desktop source surface missing");
  const scale = Math.min(1, surface.width / 1440, surface.height / 900);
  await application.evaluate(async ({ webContents }, inputScale) => {
    const candidates = webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith("http://127.0.0.1:4177"));
    let source: (typeof candidates)[number] | undefined;
    for (const candidate of candidates) {
      if (await candidate.executeJavaScript("innerWidth") === 1440) { source = candidate; break; }
    }
    if (!source) throw new Error("desktop source pane missing");
    const box = await source.executeJavaScript(`document.querySelector('[data-testid="apply"]').getBoundingClientRect().toJSON()`);
    const x = (box.x + box.width / 2) * inputScale;
    const y = (box.y + box.height / 2) * inputScale;
    await source.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await source.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }, scale);
}

async function waitForFinalInput(expected: string): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const values = await Promise.all(remotePages().map((page) => page.getByTestId("name").inputValue()));
    if (values.length === 6 && values.every((value) => value === expected)) return true;
    const next = Promise.withResolvers<void>();
    setTimeout(next.resolve, 20);
    await next.promise;
  }
  return false;
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
  const electronExecutable = electronExecutablePath();
  application = await electron.launch({ executablePath: electronExecutable, args: [...graphicsArguments, resolve("apps/desktop"), `--user-data-dir=${userData}`, "--url", "http://127.0.0.1:4177"], env: environment });
}, 30_000);

afterAll(async () => {
  await application?.close().catch(() => undefined);
  fixture?.kill("SIGTERM");
  if (userData) await rm(userData, { recursive: true, force: true });
});

describe("six-pane direct compositor", () => {
  it("meets animation, mirrored-action, final-state, long-task, and RSS gates", async () => {
    const chrome = await application.firstWindow();
    await chrome.getByRole("button", { name: "Add custom" }).click();
    await waitForPaneCount(6);
    const pages = remotePages();
    const source = pages.find((page) => page.viewportSize()?.width === 1440) ?? pages[0]!;
    const rssSamples: number[] = [await application.evaluate(() => process.memoryUsage().rss)];

    await Promise.all([chrome, ...pages].map((page) => page.evaluate(() => {
      const state = globalThis as typeof globalThis & { __longTasks?: number[]; __mirrorTimes?: number[] };
      state.__longTasks = [];
      state.__mirrorTimes = [];
      new PerformanceObserver((list) => state.__longTasks!.push(...list.getEntries().map((entry) => entry.duration))).observe({ type: "longtask" });
      document.querySelector('[data-testid="apply"]')?.addEventListener("click", () => state.__mirrorTimes!.push(Date.now()), true);
    })));
    await application.evaluate(() => {
      const state = globalThis as typeof globalThis & { __eventLoopDelay?: { enable(): void; disable(): void; max: number } };
      const { monitorEventLoopDelay } = process.getBuiltinModule("node:perf_hooks") as typeof import("node:perf_hooks");
      state.__eventLoopDelay = monitorEventLoopDelay({ resolution: 1 });
      state.__eventLoopDelay.enable();
    });

    for (let sample = 1; sample <= MIRROR_SAMPLES; sample += 1) {
      await clickDesktopSource(chrome);
      await waitForMirrorCount(sample);
    }
    const clickTimes = await Promise.all(pages.map((page) => page.evaluate(() => (globalThis as typeof globalThis & { __mirrorTimes: number[] }).__mirrorTimes)));
    const sourceIndex = pages.indexOf(source);
    const sourceTimes = clickTimes[sourceIndex]!;
    const mirrorLatencies = clickTimes.flatMap((times, pageIndex) => pageIndex === sourceIndex ? [] : times.map((time, sample) => time - sourceTimes[sample]!));
    const mirrorP95Ms = percentile(mirrorLatencies, 0.95);
    rssSamples.push(await application.evaluate(() => process.memoryUsage().rss));

    for (let update = 0; update < FINAL_INPUT_UPDATES; update += 1) await source.getByTestId("name").fill(`final-${update}`);
    const expectedFinalValue = `final-${FINAL_INPUT_UPDATES - 1}`;
    const finalStatePreserved = await waitForFinalInput(expectedFinalValue);
    rssSamples.push(await application.evaluate(() => process.memoryUsage().rss));

    const rafP95ByPane = await application.evaluate(async ({ webContents }) => {
      const panes = webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith("http://127.0.0.1:4177"));
      const values = await Promise.all(panes.map((contents) => contents.executeJavaScript(`new Promise(resolve => { const values=[]; let previous=performance.now(); const frame=now=>{ values.push(now-previous); previous=now; if(values.length===1800){values.sort((a,b)=>a-b); resolve({id:innerWidth+'x'+innerHeight,p95:values[Math.floor(values.length*0.95)]});}else requestAnimationFrame(frame)}; requestAnimationFrame(frame); })`)));
      return Object.fromEntries(values.map((value: { id: string; p95: number }) => [value.id, value.p95]));
    });
    rssSamples.push(await application.evaluate(() => process.memoryUsage().rss));

    const rendererLongTasks = await Promise.all([chrome, ...pages].map((page) => page.evaluate(() => (globalThis as typeof globalThis & { __longTasks?: number[] }).__longTasks ?? [])));
    const rendererLongTaskMaxMs = Math.max(0, ...rendererLongTasks.flat());
    const mainLongTaskMaxMs = await application.evaluate(() => {
      const state = globalThis as typeof globalThis & { __eventLoopDelay?: { disable(): void; max: number } };
      const delay = state.__eventLoopDelay;
      if (!delay) throw new Error("main event-loop monitor missing");
      delay.disable();
      return delay.max / 1_000_000;
    });
    const rssPeakBytes = Math.max(...rssSamples);
    const proof = {
      contract: "hoolypane-desktop-performance-v1",
      platform: process.platform,
      durationSeconds: 30,
      paneCount: 6,
      rafP95ByPane,
      rafP95LimitMs: RAF_P95_LIMIT_MS,
      mirror: { samples: mirrorLatencies.length, p95Ms: mirrorP95Ms },
      finalInput: { updates: FINAL_INPUT_UPDATES, expected: expectedFinalValue, preserved: finalStatePreserved },
      longTasks: { rendererMaxMs: rendererLongTaskMaxMs, mainEventLoopDelayMaxMs: mainLongTaskMaxMs },
      rss: { samplesBytes: rssSamples, peakBytes: rssPeakBytes },
    };
    await mkdir(dirname(OUTPUT), { recursive: true });
    await writeFile(OUTPUT, `${JSON.stringify(proof, null, 2)}\n`);

    expect(Object.keys(rafP95ByPane)).toHaveLength(6);
    for (const p95 of Object.values(rafP95ByPane)) expect(p95).toBeLessThanOrEqual(RAF_P95_LIMIT_MS);
    expect(mirrorP95Ms).toBeLessThan(16.7);
    expect(finalStatePreserved).toBe(true);
    expect(rendererLongTaskMaxMs).toBeLessThanOrEqual(50);
    expect(mainLongTaskMaxMs).toBeLessThanOrEqual(50);
    expect(rssPeakBytes).toBeLessThan(2 * 1024 * 1024 * 1024);
  }, 90_000);
});
