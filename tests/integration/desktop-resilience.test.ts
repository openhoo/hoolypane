import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let fixture: ChildProcess;
let application: ElectronApplication;
let chrome: Page;
let directory = "";

function sourcePage(path = "/"): Page {
  const candidates = application.context().pages().filter((page) => page.url() === `http://127.0.0.1:4179${path}`);
  return candidates.find((page) => page.viewportSize()?.width === 1440) ?? candidates[0]!;
}

async function waitForRemotePages(path: string, expected = 5): Promise<Page[]> {
  const target = `http://127.0.0.1:4179${path}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pages = application.context().pages().filter((page) => page.url() === target);
    if (pages.length === expected) return pages;
    const next = Promise.withResolvers<void>();
    setTimeout(next.resolve, 20);
    await next.promise;
  }
  throw new Error(`desktop did not reach ${expected} pages at ${target}`);
}

async function waitForMirroredName(value: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pages = application.context().pages().filter((page) => page.url().startsWith("http://127.0.0.1:4179"));
    const values = await Promise.all(pages.map((page) => page.getByTestId("name").inputValue().catch(() => "")));
    if (values.length === 5 && values.every((candidate) => candidate === value)) return;
    const next = Promise.withResolvers<void>();
    setTimeout(next.resolve, 20);
    await next.promise;
  }
  throw new Error(`final mirrored value did not converge: ${value}`);
}

beforeAll(async () => {
  fixture = spawn(process.execPath, [resolve("tests/fixtures/server.mjs")], { env: { ...process.env, PORT: "4179" }, stdio: ["ignore", "pipe", "inherit"] });
  const ready = Promise.withResolvers<void>();
  fixture.stdout?.on("data", (data: Buffer) => { if (data.toString().includes("fixture ready")) ready.resolve(); });
  fixture.once("error", ready.reject);
  await ready.promise;
  directory = await mkdtemp(join(tmpdir(), "hoolypane-resilience-"));
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  Object.assign(environment, { HOOLYPANE_TEST_MODE: "1", HOOLYPANE_TEST_REPLAY_DELAY_MS: "150" });
  if (process.platform === "linux") {
    environment.XDG_SESSION_TYPE = "x11";
    delete environment.WAYLAND_DISPLAY;
  }
  const graphicsArguments = process.platform === "linux" ? ["--ozone-platform=x11", "--use-gl=angle", "--use-angle=swiftshader"] : [];
  const electronExecutable = resolve(`apps/desktop/node_modules/electron/dist/electron${process.platform === "win32" ? ".exe" : ""}`);
  application = await electron.launch({ executablePath: electronExecutable, args: [...graphicsArguments, resolve("apps/desktop"), `--user-data-dir=${join(directory, "user-data")}`, "--url", "http://127.0.0.1:4179"], env: environment });
  chrome = await application.firstWindow();
  await waitForRemotePages("/");
}, 30_000);

afterAll(async () => {
  await application?.close().catch(() => undefined);
  fixture?.kill("SIGTERM");
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("desktop replay and security resilience", () => {
  it("rejects stale generations and converges after navigation with pending replay", async () => {
    const stale = await application.evaluate(({ ipcMain, webContents }) => {
      const pane = webContents.getAllWebContents().find((contents) => contents.getURL() === "http://127.0.0.1:4179/");
      if (!pane) throw new Error("pane missing for stale replay");
      const completion = Promise.withResolvers<unknown>();
      const timer = setTimeout(() => completion.reject(new Error("stale replay result timeout")), 5_000);
      const listener = (event: Electron.IpcMainEvent, value: { actionId?: number }) => {
        if (event.sender !== pane || value.actionId !== 9_999) return;
        clearTimeout(timer);
        ipcMain.removeListener("hoolypane:replay-result", listener);
        completion.resolve(value);
      };
      ipcMain.on("hoolypane:replay-result", listener);
      pane.send("hoolypane:replay", { actionId: 9_999, documentGeneration: 999, action: { kind: "click", locator: { kind: "testId", value: "apply" } }, phase: "resolve" });
      return completion.promise;
    }) as { ok: boolean; reason?: string };
    expect(stale.ok).toBe(false);
    expect(stale.reason).toMatch(/stale document generation/);

    await sourcePage().getByTestId("name").fill("stale-before-navigation");
    await chrome.locator("#address").fill("http://127.0.0.1:4179/next");
    await chrome.locator("#address").press("Enter");
    await waitForRemotePages("/next");
    await sourcePage("/next").getByTestId("name").fill("after-navigation");
    await waitForMirroredName("after-navigation");
    expect(await chrome.getByText(/Out of sync/).count()).toBe(0);
  }, 30_000);

  it("denies permissions, downloads, popups, and external protocols", async () => {
    const page = sourcePage("/next");
    expect(await page.evaluate(() => navigator.permissions.query({ name: "geolocation" }).then((permission) => permission.state))).toBe("denied");
    const pageCount = application.context().pages().length;
    await page.evaluate(() => window.open("mailto:security@example.test"));
    expect(application.context().pages()).toHaveLength(pageCount);

    const downloadState = await application.evaluate(async ({ webContents }) => {
      const pane = webContents.getAllWebContents().find((contents) => contents.getURL() === "http://127.0.0.1:4179/next");
      if (!pane) throw new Error("pane missing for download test");
      const completion = Promise.withResolvers<string>();
      const timer = setTimeout(() => completion.reject(new Error("download event timeout")), 5_000);
      pane.session.once("will-download", (_event, item) => setImmediate(() => {
        clearTimeout(timer);
        completion.resolve(item.getState());
      }));
      await pane.executeJavaScript(`(() => { const link=document.createElement('a'); link.href='data:text/plain,blocked'; link.download='blocked.txt'; document.body.append(link); link.click(); link.remove(); })()`);
      return completion.promise;
    });
    expect(downloadState).toBe("cancelled");

    await page.evaluate(() => window.open("http://127.0.0.1:4179/popup"));
    expect(application.context().pages()).toHaveLength(pageCount);
    await waitForRemotePages("/popup", 1);
  }, 20_000);

  it("keeps siblings alive when one renderer crashes", async () => {
    const pid = await application.evaluate(({ webContents }) => {
      const pane = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith("http://127.0.0.1:4179"));
      if (!pane) throw new Error("pane missing for crash test");
      return pane.getOSProcessId();
    });
    if (process.platform === "win32") {
      const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/F", "/T"]);
      if (result.status !== 0) throw new Error(`taskkill failed: ${result.stderr.toString()}`);
    } else {
      process.kill(pid, "SIGKILL");
    }
    await chrome.getByText(/render process gone/).first().waitFor({ state: "attached", timeout: 10_000 });
    const healthy = await Promise.all(application.context().pages().filter((page) => page.url().startsWith("http://127.0.0.1:4179")).map((page) => page.title().catch(() => "crashed")));
    expect(healthy.filter((title) => title === "Hoolypane fixture").length).toBeGreaterThanOrEqual(4);
  }, 20_000);
});
