import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runFlow } from "../../packages/runner/src/run-flow.js";
import { OVERVIEW_ERROR_TILE_COLOR } from "../../apps/desktop/src/main/screenshots/overview-shared.js";
import { TEST_FLOW_PATH_ENV, TEST_FLOW_SAVE_CANCEL_ENV, TEST_MODE_ENV, TEST_OVERVIEW_PNG_ENV, TEST_PANE_PNG_ENV } from "../../apps/desktop/src/main/test-env.js";
import { launchDesktopApp, pollUntil, startFixtureServer, teardownDesktopSuite, waitForFixturePanes, type FixtureServer } from "../helpers/harness.js";
import { inlineConfigSource } from "../helpers/inline-config.js";
import { clickPaneSurface } from "./cdp-input.js";
import { FIXTURE_PORTS, fixtureOrigin } from "../fixtures/ports.js";

const FIXTURE_PORT = FIXTURE_PORTS.artifacts;

let fixture: FixtureServer | undefined;
let application: ElectronApplication;
let chrome: Page;
let directory = "";
let panePng = "";
let overviewPng = "";
let errorOverviewPng = "";
let flowPath = "";

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  await pollUntil(async () => {
    try {
      await access(path);
      return true;
    } catch {
      return null; // writer not finished
    }
  }, timeoutMs);
}

async function appliedCount(): Promise<number> {
  return fetch(`${fixtureOrigin(FIXTURE_PORT)}/applied-count`)
    .then((response) => response.json())
    .then((value: { count: number }) => value.count);
}

async function waitForAppliedCount(expected: number, atLeast = false): Promise<void> {
  await pollUntil(async () => {
    const count = await appliedCount();
    return (atLeast ? count >= expected : count === expected) ? count : null;
  }, 10_000);
}

async function clickDesktopApply(): Promise<void> {
  await clickPaneSurface(application, chrome, { port: FIXTURE_PORT, testId: "apply", expectedStatus: "applied" });
}

async function startRecording(): Promise<void> {
  await chrome.getByRole("button", { name: "Start Flow Recording" }).click();
  // Recording readiness is observable through the enabled Stop control; no frame-timing sync needed.
  await chrome.getByRole("button", { name: "Stop Flow Recording" }).waitFor({ state: "visible" });
}

async function stopRecording(): Promise<void> {
  await chrome.getByRole("button", { name: "Stop Flow Recording" }).click();
  await chrome.getByRole("button", { name: "Start Flow Recording" }).waitFor({ state: "visible" });
}

beforeAll(async () => {
  fixture = await startFixtureServer(FIXTURE_PORT);
  directory = await mkdtemp(join(tmpdir(), "hoolypane-artifacts-"));
  panePng = join(directory, "pane.png");
  overviewPng = join(directory, "overview.png");
  errorOverviewPng = join(directory, "overview-error.png");
  flowPath = join(directory, "recorded.flow.ts");
  const launch = await launchDesktopApp({
    port: FIXTURE_PORT,
    userDataDir: directory,
    extraEnv: {
      [TEST_MODE_ENV]: "1",
      [TEST_PANE_PNG_ENV]: panePng,
      [TEST_OVERVIEW_PNG_ENV]: overviewPng,
      [TEST_FLOW_PATH_ENV]: flowPath,
    },
  });
  application = launch.application;
  chrome = launch.chrome;
  // Native child views expose no readiness event to Playwright; poll Electron's authoritative WebContents registry.
  await waitForFixturePanes(application, FIXTURE_PORT, 5, 20_000);
}, 45_000);

let evidenceDirty = false;

afterEach((context) => {
  const state = context.task.result?.state;
  if (state === "fail") evidenceDirty = true;
});

afterAll(async () => {
  await application?.close().catch(() => undefined);
  await fixture?.close();
  // Preserve the whole scratch directory (screenshots, recorded flow, runner output,
  // workspace store) for diagnosis before the cleanup below destroys it.
  if (directory && evidenceDirty) {
    const dumpDir = await mkdtemp(join(tmpdir(), "artifacts-fail-dump-"));
    cpSync(directory, join(dumpDir, "artifacts"), { recursive: true });
    console.log(`ARTIFACTS FAIL DUMP copied to ${join(dumpDir, "artifacts")}`);
  }
  if (directory) await rm(directory, { recursive: true, force: true });
}, 30_000);

describe("desktop screenshots and recorded flows", () => {
  it("exports a pane still", async () => {
    await chrome.getByRole("button", { name: "Save PNG" }).first().click();
    await waitForFile(panePng);
    expect(await sharp(panePng).metadata()).toMatchObject({ format: "png" });
  }, 20_000);

  it("exports an overview still of all panes", async () => {
    await chrome.getByRole("button", { name: "Save Overview PNG" }).click();
    // Five cold native capturePage calls can exceed 10 s on Windows runners before the
    // separately bounded overview worker begins composing.
    await waitForFile(overviewPng, 30_000);
    expect((await sharp(await readFile(overviewPng)).metadata()).width).toBeGreaterThan(500);
  }, 40_000);

  it("records a flow and replays it through the runner", async () => {
    const baseline = await appliedCount();
    await startRecording();
    await clickDesktopApply();
    await waitForAppliedCount(baseline + 5, true);
    await stopRecording();
    await waitForFile(flowPath);
    const flowSource = await readFile(flowPath, "utf8");
    expect(flowSource).toContain('import { defineFlow } from "@hoolypane/runner";');
    expect(flowSource).toContain('getByTestId("apply").click()');

    await fetch(`${fixtureOrigin(FIXTURE_PORT)}/reset`);
    const configPath = join(directory, "hoolypane.config.ts");
    await writeFile(configPath, inlineConfigSource(fixtureOrigin(FIXTURE_PORT), [{ id: "one", name: "One", width: 320, height: 240, deviceScaleFactor: 1, isMobile: false, hasTouch: false }, { id: "two", name: "Two", width: 180, height: 320, deviceScaleFactor: 1, isMobile: true, hasTouch: true }]));
    const runOutput = join(directory, "runner-output");
    const run = await runFlow({ flowFile: flowPath, configFile: configPath, outputDir: runOutput, headed: false });
    expect(run.status).toBe("success");
    await waitForAppliedCount(2);
  }, 90_000);

  it("does not save an empty flow", async () => {
    const emptyPath = join(directory, "empty.flow.ts");
    await application.evaluate((_electron, [name, path]) => { process.env[name] = path; }, [TEST_FLOW_PATH_ENV, emptyPath]);
    try {
      await startRecording();
      await stopRecording();
      await expect(access(emptyPath)).rejects.toBeDefined();
    } finally {
      // Restore the launch baseline locally so no later test inherits an overridden flow path.
      await application.evaluate((_electron, [name, path]) => { process.env[name] = path; }, [TEST_FLOW_PATH_ENV, flowPath]).catch(() => undefined);
    }
  }, 20_000);

  it("does not save a cancelled flow despite mirrored actions", async () => {
    const canceledPath = join(directory, "canceled.flow.ts");
    await application.evaluate((_electron, env) => { process.env[env.path] = env.value; process.env[env.saveCancel] = "1"; }, { path: TEST_FLOW_PATH_ENV, saveCancel: TEST_FLOW_SAVE_CANCEL_ENV, value: canceledPath });
    try {
      const baseline = await appliedCount();
      await startRecording();
      await clickDesktopApply();
      await waitForAppliedCount(baseline + 5, true);
      await stopRecording();
      await expect(access(canceledPath)).rejects.toBeDefined();
    } finally {
      // Restore the launch baseline locally so no later test inherits SAVE_CANCEL=1
      // or an overridden HOOLYPANE_TEST_FLOW_PATH.
      await application.evaluate((_electron, name) => { delete process.env[name]; }, TEST_FLOW_SAVE_CANCEL_ENV).catch(() => undefined);
      await application.evaluate((_electron, [name, path]) => { process.env[name] = path; }, [TEST_FLOW_PATH_ENV, flowPath]).catch(() => undefined);
    }
  }, 30_000);

  it("marks missing panes in the overview export", async () => {
    // This test overrides export env and closes a pane, so it runs against a dedicated
    // app instance; the shared app keeps its baseline env and all five panes intact.
    // Self-sufficiency: never depend on the earlier independent overview test having run;
    // refresh the baseline PNG from the shared instance before comparing against it.
    await chrome.getByRole("button", { name: "Save Overview PNG" }).click();
    await waitForFile(overviewPng);
    const isolatedDir = await mkdtemp(join(tmpdir(), "hoolypane-artifacts-error-"));
    const launch = await launchDesktopApp({
      port: FIXTURE_PORT,
      userDataDir: isolatedDir,
      extraEnv: {
        [TEST_MODE_ENV]: "1",
        [TEST_PANE_PNG_ENV]: join(isolatedDir, "pane.png"),
        [TEST_OVERVIEW_PNG_ENV]: errorOverviewPng,
        [TEST_FLOW_PATH_ENV]: join(isolatedDir, "recorded.flow.ts"),
      },
    });
    try {
      await waitForFixturePanes(launch.application, FIXTURE_PORT, 5);
      await launch.application.evaluate(({ webContents }, origin) => {
        const pane = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(origin));
        if (!pane) throw new Error("pane missing for error-overview test");
        pane.close({ waitForBeforeUnload: false });
      }, fixtureOrigin(FIXTURE_PORT));
      await waitForFixturePanes(launch.application, FIXTURE_PORT, 4);
      await launch.chrome.getByRole("button", { name: "Save Overview PNG" }).click();
      await waitForFile(errorOverviewPng);
      const errorPixels = await sharp(errorOverviewPng).ensureAlpha().raw().toBuffer();
      const [errorRed, errorGreen, errorBlue] = [1, 3, 5].map((index) => Number.parseInt(OVERVIEW_ERROR_TILE_COLOR.slice(index, index + 2), 16));
      let errorBackgroundPixels = 0;
      for (let offset = 0; offset < errorPixels.length; offset += 4) if (errorPixels[offset] === errorRed && errorPixels[offset + 1] === errorGreen && errorPixels[offset + 2] === errorBlue) errorBackgroundPixels += 1;
      expect(errorBackgroundPixels).toBeGreaterThan(1_000);
      expect(await readFile(errorOverviewPng)).not.toEqual(await readFile(overviewPng));
    } finally {
      // Tolerant of an already-closed launch; the shared fixture server stays untouched.
      await teardownDesktopSuite(launch.application, undefined, isolatedDir);
    }
  }, 60_000);
});
