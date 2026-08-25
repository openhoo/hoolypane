import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import type { ElectronApplication, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "../../packages/contracts/src/index.js";
import { launchDesktopApp, pollUntil, startFixtureServer, type FixtureServer } from "../helpers/harness.js";
import { FIXTURE_PORTS } from "../fixtures/ports.js";

const FIXTURE_PORT = FIXTURE_PORTS.resilience;

let fixture: FixtureServer | undefined;
let application: ElectronApplication;
let chrome: Page;
let userDataDir = "";

function sourcePage(path = "/"): Page {
  const candidates = application.context().pages().filter((page) => page.url() === `http://127.0.0.1:${FIXTURE_PORT}${path}`);
  return candidates.find((page) => page.viewportSize()?.width === 1440) ?? candidates[0]!;
}

async function waitForRemotePages(path: string, expected = 5): Promise<Page[]> {
  const target = `http://127.0.0.1:${FIXTURE_PORT}${path}`;
  return pollUntil(async () => {
    const pages = application.context().pages().filter((page) => page.url() === target);
    return pages.length === expected ? pages : null;
  }, 10_000);
}

async function waitForMirroredName(value: string): Promise<void> {
  await pollUntil(async () => {
    const pages = application.context().pages().filter((page) => page.url().startsWith(`http://127.0.0.1:${FIXTURE_PORT}`));
    const values = await Promise.all(pages.map((page) => page.getByTestId("name").inputValue().catch(() => "")));
    return values.length === 5 && values.every((candidate) => candidate === value);
  }, 10_000);
}

async function waitForNoOutOfSync(): Promise<void> {
  let clearSince = 0;
  await pollUntil(async () => {
    if (await chrome.getByText(/out of sync/i).count() === 0) {
      if (clearSince === 0) clearSince = Date.now();
      else if (Date.now() - clearSince >= 300) return true;
    } else clearSince = 0;
    return null;
  }, 10_000);
}

beforeAll(async () => {
  fixture = await startFixtureServer(FIXTURE_PORT);
  const launch = await launchDesktopApp({
    port: FIXTURE_PORT,
    extraEnv: { HOOLYPANE_TEST_MODE: "1", HOOLYPANE_TEST_REPLAY_DELAY_MS: "150" },
  });
  application = launch.application;
  chrome = launch.chrome;
  userDataDir = launch.userDataDir;
  await waitForRemotePages("/");
}, 30_000);

afterAll(async () => {
  await application?.close().catch(() => undefined);
  await fixture?.close();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
}, 30_000);

describe("desktop replay and security resilience", () => {
  it("rejects stale generations and converges after navigation with pending replay", async () => {
    const stale = await application.evaluate(async ({ ipcMain, webContents }, channels) => {
      const pane = webContents.getAllWebContents().find((contents) => contents.getURL() === `${channels.port}/`);
      if (!pane) throw new Error("pane missing for stale replay");
      const completion = Promise.withResolvers<unknown>();
      const timer = setTimeout(() => completion.reject(new Error("stale replay result timeout")), 5_000);
      const listener = (event: Electron.IpcMainEvent, value: { actionId?: number }) => {
        if (event.sender !== pane || value.actionId !== 9_999) return;
        clearTimeout(timer);
        completion.resolve(value);
      };
      ipcMain.on(channels.replayResult, listener);
      pane.send(channels.replay, { actionId: 9_999, documentGeneration: 999, action: { kind: "click", locator: { kind: "testId", value: "apply" } }, phase: "resolve" });
      try {
        return await completion.promise;
      } finally {
        clearTimeout(timer);
        ipcMain.removeListener(channels.replayResult, listener);
      }
    }, { replay: IPC_CHANNELS.replay, replayResult: IPC_CHANNELS.replayResult, port: `http://127.0.0.1:${FIXTURE_PORT}` }) as { ok: boolean; reason?: string };
    expect(stale.ok).toBe(false);
    expect(stale.reason).toMatch(/stale document generation/);

    await sourcePage().getByTestId("name").fill("stale-before-navigation");
    await chrome.locator("#address").fill(`http://127.0.0.1:${FIXTURE_PORT}/next`);
    await chrome.locator("#address").press("Enter");
    await waitForRemotePages("/next");
    await sourcePage("/next").getByTestId("name").fill("after-navigation");
    await waitForMirroredName("after-navigation");
    await waitForNoOutOfSync();
  }, 30_000);

  it("denies permissions, downloads, popups, and external protocols", async () => {
    const page = sourcePage("/next");
    expect(await page.evaluate(() => navigator.permissions.query({ name: "geolocation" }).then((permission) => permission.state))).toBe("denied");
    const pageCount = application.context().pages().length;
    await page.evaluate(() => window.open("mailto:security@example.test"));
    expect(application.context().pages()).toHaveLength(pageCount);

    const downloadState = await application.evaluate(async ({ webContents }, port) => {
      const pane = webContents.getAllWebContents().find((contents) => contents.getURL() === `http://127.0.0.1:${port}/next`);
      if (!pane) throw new Error("pane missing for download test");
      const completion = Promise.withResolvers<string>();
      const onDownload = (_event: Electron.Event, item: Electron.DownloadItem) => setImmediate(() => completion.resolve(item.getState()));
      const timer = setTimeout(() => completion.reject(new Error("download event timeout")), 5_000);
      pane.session.once("will-download", onDownload);
      try {
        await pane.executeJavaScript(`(() => { const link=document.createElement('a'); link.href='data:text/plain,blocked'; link.download='blocked.txt'; document.body.append(link); link.click(); link.remove(); })()`);
        return await completion.promise;
      } finally {
        clearTimeout(timer);
        pane.session.removeListener("will-download", onDownload);
      }
    }, FIXTURE_PORT);
    expect(downloadState).toBe("cancelled");

    await page.evaluate((url) => window.open(url), `http://127.0.0.1:${FIXTURE_PORT}/popup`);
    expect(application.context().pages()).toHaveLength(pageCount);
    await waitForRemotePages("/popup", 1);
  }, 20_000);

  it("keeps siblings alive when one renderer crashes", async () => {
    const pid = await application.evaluate(({ webContents }, port) => {
      const pane = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(`http://127.0.0.1:${port}`));
      if (!pane) throw new Error("pane missing for crash test");
      return pane.getOSProcessId();
    }, FIXTURE_PORT);
    if (process.platform === "win32") {
      const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/F", "/T"]);
      if (result.status !== 0) throw new Error(`taskkill failed: ${result.stderr.toString()}`);
    } else {
      process.kill(pid, "SIGKILL");
    }
    await chrome.getByText(/render process gone/).first().waitFor({ state: "attached", timeout: 10_000 });
    const healthy = await Promise.all(application.context().pages().filter((page) => page.url().startsWith(`http://127.0.0.1:${FIXTURE_PORT}`)).map((page) => page.title().catch(() => "crashed")));
    expect(healthy.filter((title) => title.startsWith("Nimbus Analytics")).length).toBeGreaterThanOrEqual(4);
  }, 20_000);
});
