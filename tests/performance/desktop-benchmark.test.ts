import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixturePaneCount, fixturePages, launchDesktopApp, locateSourcePane, pollUntil, startFixtureServer, teardownDesktopSuite, withReloadRetry, type FixtureServer } from "../helpers/harness.js";
import { clickPaneSurface } from "../integration/cdp-input.js";
import { FIXTURE_PORTS, fixtureOrigin } from "../fixtures/ports.js";

const FIXTURE_PORT = FIXTURE_PORTS.benchmark;
const OUTPUT = resolve(process.env.HOOLYPANE_DESKTOP_BENCHMARK_OUTPUT ?? ".tmp/desktop-benchmark-proof.json");
const MIRROR_SAMPLES = 120;
const FINAL_INPUT_UPDATES = 100;
let fixture: FixtureServer | undefined;
let application: ElectronApplication;
let chrome: Page;
let userDataDir = "";

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) throw new Error("cannot compute percentile of empty measurements");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))]!;
}

function remotePages(): Page[] {
  return fixturePages(application, FIXTURE_PORT);
}

async function waitForPaneCount(expected: number): Promise<void> {
  await pollUntil(async () =>
    await fixturePaneCount(application, FIXTURE_PORT) === expected && remotePages().length === expected || null,
  10_000);
}

async function waitForMirrorCount(expected: number): Promise<void> {
  await pollUntil(async () => {
    const counts = await Promise.all(remotePages().map((page) => page.evaluate(() => (globalThis as typeof globalThis & { __mirrorTimes?: number[] }).__mirrorTimes?.length ?? 0).catch(() => -1)));
    return counts.length === 6 && counts.every((count) => count >= expected);
  }, 5_000, 5);
}


async function waitForFinalInput(expected: string): Promise<boolean> {
  try {
    return await pollUntil(async () => {
      const values = await Promise.all(remotePages().map((page) => page.getByTestId("name").inputValue().catch(() => null)));
      return values.length === 6 && values.every((value) => value === expected);
    }, 10_000);
  } catch {
    return false;
  }
}


/** Point sample of the main process only; kept in the proof artifact alongside the aggregate peak. */
function mainProcessRssBytes(): Promise<number> {
  return application.evaluate(() => process.memoryUsage().rss);
}

/**
 * Kernel-tracked per-process high-water marks summed across ALL Electron processes
 * (main, renderers, GPU, utility); main-process sampling alone never observes them.
 */
function aggregatePeakRssBytes(): Promise<number> {
  return application.evaluate((electron) =>
    electron.app.getAppMetrics().reduce((total, metric) => total + metric.memory.peakWorkingSetSize, 0) * 1024,
  );
}

beforeAll(async () => {
  fixture = await startFixtureServer(FIXTURE_PORT);
  const launch = await launchDesktopApp({ port: FIXTURE_PORT });
  application = launch.application;
  chrome = launch.chrome;
  userDataDir = launch.userDataDir;
}, 30_000);

afterAll(() => teardownDesktopSuite(application, fixture, userDataDir), 30_000);

describe("six-pane direct compositor", () => {
  it("meets animation, mirrored-action, final-state, long-task, and RSS gates", async () => {
    const startedAtMs = Date.now();
    await chrome.getByRole("button", { name: "Add custom" }).click();
    await waitForPaneCount(6);
    const pages = remotePages();
    await Promise.all(pages.map((page) => page.getByTestId("apply").waitFor({ state: "visible" })));
    const source = locateSourcePane(pages)!;
    const rssSamples: number[] = [await mainProcessRssBytes()];

    await Promise.all([chrome, ...pages].map((page) => page.evaluate(() => {
      const state = globalThis as typeof globalThis & { __longTasks?: number[]; __mirrorTimes?: number[] };
      state.__longTasks = [];
      state.__mirrorTimes = [];
      new PerformanceObserver((list) => state.__longTasks!.push(...list.getEntries().map((entry) => entry.duration))).observe({ type: "longtask" });
      document.querySelector('[data-testid="apply"]')?.addEventListener("click", () => state.__mirrorTimes!.push(Date.now()), true);
    })));
    await application.evaluate(() => {
      const state = globalThis as typeof globalThis & { __eventLoopDelay?: { enable(): void; disable(): void; max: number; percentile(value: number): number } };
      const { monitorEventLoopDelay } = process.getBuiltinModule("node:perf_hooks") as typeof import("node:perf_hooks");
      state.__eventLoopDelay = monitorEventLoopDelay({ resolution: 1 });
      state.__eventLoopDelay.enable();
    });

    for (let sample = 1; sample <= MIRROR_SAMPLES; sample += 1) {
      await clickPaneSurface(application, chrome, { port: FIXTURE_PORT, testId: "apply", expectedStatus: "applied" });
      await waitForMirrorCount(sample);
    }
    const clickTimes = await Promise.all(pages.map((page) => page.evaluate(() => (globalThis as typeof globalThis & { __mirrorTimes: number[] }).__mirrorTimes)));
    // Pairing assumes strict 1:1 samples; waitForMirrorCount only enforces a lower bound,
    // so an over- or under-collecting pane would silently misalign every latency pair.
    for (const [pageIndex, times] of clickTimes.entries()) {
      // A transient renderer reload leaves __mirrorTimes undefined; report the designed message instead of crashing on a TypeError.
      const collected = Array.isArray(times) ? times.length : -1;
      if (collected !== MIRROR_SAMPLES) throw new Error(`pane ${pages[pageIndex]!.url()} collected ${collected} mirror timestamps, expected exactly ${MIRROR_SAMPLES}`);
    }
    const sourceIndex = pages.indexOf(source);
    const sourceTimes = clickTimes[sourceIndex]!;
    const pairedLatencies = clickTimes.flatMap((times, pageIndex) => pageIndex === sourceIndex ? [] : times.map((time, sample) => time - sourceTimes[sample]!));
    const mirrorLatencies = pairedLatencies.filter((latency) => Number.isFinite(latency));
    if (mirrorLatencies.length !== pairedLatencies.length) throw new Error(`${pairedLatencies.length - mirrorLatencies.length} non-finite mirror latencies would poison the percentile gate`);
    const mirrorP95Ms = percentile(mirrorLatencies, 0.95);
    rssSamples.push(await mainProcessRssBytes());

    for (let update = 0; update < FINAL_INPUT_UPDATES; update += 1) await source.getByTestId("name").fill(`final-${update}`);
    const expectedFinalValue = `final-${FINAL_INPUT_UPDATES - 1}`;
    const finalStatePreserved = await waitForFinalInput(expectedFinalValue);
    rssSamples.push(await mainProcessRssBytes());

    // A transient renderer reload invalidates execution contexts mid-sample; retry the
    // steady-state cadence sample once instead of failing the gate opaquely.
    const displayCadenceP95Ms = await withReloadRetry("display cadence sample", () => chrome.evaluate(() => {
      const { promise, resolve } = Promise.withResolvers<number>();
      const intervals: number[] = [];
      let previous = performance.now();
      const sample = (now: number): void => {
        intervals.push(now - previous);
        previous = now;
        if (intervals.length < 180) requestAnimationFrame(sample);
        else {
          intervals.sort((left, right) => left - right);
          resolve(intervals[Math.floor(intervals.length * 0.95)]!);
        }
      };
      requestAnimationFrame(sample);
      return promise;
    }));
    const rafP95LimitMs = Math.max(20, displayCadenceP95Ms * 1.05);
    const rafP95ByPane = await application.evaluate(async ({ webContents }, origin) => {
      const panes = webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith(origin));
      const values = await Promise.all(panes.map(async (contents) => {
        const sampleSource = "new Promise(resolve => { const values=[]; let previous=performance.now(); const frame=now=>{ values.push(now-previous); previous=now; if(values.length===1800){values.sort((a,b)=>a-b); resolve({id:innerWidth+'x'+innerHeight,p95:values[Math.floor(values.length*0.95)]});}else requestAnimationFrame(frame)}; requestAnimationFrame(frame); })";
        try {
          return await contents.executeJavaScript(sampleSource);
        } catch {
          // Same transient-reload tolerance as the chrome sampler above.
          return await contents.executeJavaScript(sampleSource);
        }
      }));
      return Object.fromEntries(values.map((value: { id: string; p95: number }) => [value.id, value.p95]));
    }, fixtureOrigin(FIXTURE_PORT));
    rssSamples.push(await mainProcessRssBytes());

    const rendererLongTasks = await Promise.all([chrome, ...pages].map((page) => page.evaluate(() => (globalThis as typeof globalThis & { __longTasks?: number[] }).__longTasks ?? [])));
    const rendererLongTaskMaxMs = Math.max(0, ...rendererLongTasks.flat());
    const mainEventLoopDelay = await application.evaluate(() => {
      const state = globalThis as typeof globalThis & { __eventLoopDelay?: { disable(): void; max: number; percentile(value: number): number } };
      const delay = state.__eventLoopDelay;
      if (!delay) throw new Error("main event-loop monitor missing");
      delay.disable();
      return { maxMs: delay.max / 1_000_000, p99Ms: delay.percentile(99) / 1_000_000 };
    });
    const rssPeakBytes = await aggregatePeakRssBytes();
    const proof = {
      contract: "hoolypane-desktop-performance-v1",
      platform: process.platform,
      durationSeconds: Math.round((Date.now() - startedAtMs) / 100) / 10,
      paneCount: 6,
      rafP95ByPane,
      displayCadenceP95Ms,
      rafP95LimitMs,
      mirror: { samples: mirrorLatencies.length, p95Ms: mirrorP95Ms },
      finalInput: { updates: FINAL_INPUT_UPDATES, expected: expectedFinalValue, preserved: finalStatePreserved },
      longTasks: { rendererMaxMs: rendererLongTaskMaxMs, mainEventLoopDelay },
      rss: { samplesBytes: rssSamples, peakBytes: rssPeakBytes },
    };
    await mkdir(dirname(OUTPUT), { recursive: true });
    await writeFile(OUTPUT, `${JSON.stringify(proof, null, 2)}\n`);

    expect(Object.keys(rafP95ByPane)).toHaveLength(6);
    for (const p95 of Object.values(rafP95ByPane)) expect(p95).toBeLessThanOrEqual(rafP95LimitMs);
    expect(mirrorP95Ms).toBeLessThan(16.7);
    expect(finalStatePreserved).toBe(true);
    expect(rendererLongTaskMaxMs).toBeLessThanOrEqual(50);
    expect(mainEventLoopDelay.p99Ms).toBeLessThanOrEqual(50);
    expect(rssPeakBytes).toBeLessThan(2 * 1024 * 1024 * 1024);
  }, 90_000);
});
