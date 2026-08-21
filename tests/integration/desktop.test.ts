import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { electronExecutablePath } from "../electron-executable.js";

let fixture: ChildProcess;
let application: ElectronApplication;
let chrome: Page;
let userData: string;

async function paneCount(): Promise<number> {
  return application.evaluate(({ webContents }) => webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith("http://127.0.0.1:4175")).length);
}

async function waitForPaneCount(expected: number): Promise<void> {
  // Native child views expose no readiness event to Playwright; poll Electron's authoritative WebContents registry.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await paneCount() === expected) return;
    const next = Promise.withResolvers<void>();
    setTimeout(next.resolve, 20);
    await next.promise;
  }
  throw new Error(`desktop did not reach ${expected} panes`);
}
interface PaneSnapshot {
  readonly name: string;
  readonly theme: string;
  readonly checked: boolean;
  readonly status: string;
  readonly scrollRatio: number;
}

async function paneSnapshots(): Promise<Array<PaneSnapshot | null>> {
  return application.evaluate(async ({ webContents }) => Promise.all(
    webContents.getAllWebContents()
      .filter((contents) => contents.getURL().startsWith("http://127.0.0.1:4175"))
      .map((contents) => contents.executeJavaScript(`(() => { const name = document.querySelector('[data-testid="name"]'); const theme = document.querySelector('[data-testid="theme"]'); const subscribe = document.querySelector('[data-testid="subscribe"]'); const status = document.querySelector('[data-testid="status"]'); const scroller = document.querySelector('[data-testid="scroller"]'); if (!name || !theme || !subscribe || !status || !scroller) return null; return { name: name.value, theme: theme.value, checked: subscribe.checked, status: status.textContent, scrollRatio: scroller.scrollTop / (scroller.scrollHeight - scroller.clientHeight) }; })()`)),
  ));
}

async function waitForPaneState(predicate: (snapshots: readonly PaneSnapshot[]) => boolean, label: string): Promise<PaneSnapshot[]> {
  // Mirrored native events expose completion only through page state in each independent WebContents.
  const deadline = Date.now() + 10_000;
  let latest: Array<PaneSnapshot | null> = [];
  while (Date.now() < deadline) {
    const snapshots = await paneSnapshots();
    latest = snapshots;
    const ready = snapshots.filter((snapshot): snapshot is PaneSnapshot => snapshot !== null);
    if (ready.length === 5 && predicate(ready)) return ready;
    const next = Promise.withResolvers<void>();
    setTimeout(next.resolve, 20);
    await next.promise;
  }
  throw new Error(`desktop panes did not converge after ${label}: ${JSON.stringify(latest)}`);
}

function sourcePage(): Page {
  const remotePages = application.context().pages().filter((page) => page.url().startsWith("http://127.0.0.1:4175"));
  const source = remotePages.find((page) => page.viewportSize()?.width === 1440) ?? remotePages[0];
  if (!source) throw new Error("source pane missing");
  return source;
}
async function clickSource(testId: string): Promise<void> {
  const surface = await chrome.locator('[data-pane-surface="desktop-1440"]').boundingBox();
  if (!surface) throw new Error("desktop source surface missing");
  const scale = Math.min(1, surface.width / 1440, surface.height / 900);
  await application.evaluate(async ({ webContents }, input) => {
    const candidates = webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith("http://127.0.0.1:4175"));
    let source: (typeof candidates)[number] | undefined;
    for (const candidate of candidates) {
      if (await candidate.executeJavaScript("innerWidth") === 1440) { source = candidate; break; }
    }
    if (!source) throw new Error("desktop source pane missing");
    const box = await source.executeJavaScript(`document.querySelector('[data-testid="${input.testId}"]').getBoundingClientRect().toJSON()`);
    const x = (box.x + box.width / 2) * input.scale;
    const y = (box.y + box.height / 2) * input.scale;
    await source.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await source.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }, { testId, scale });
}

async function fillSource(value: string): Promise<void> {
  await sourcePage().getByTestId("name").fill(value);
}

async function pressSourceEnter(): Promise<void> {
  await sourcePage().getByTestId("command").press("Enter");
}

async function selectSourceDark(): Promise<void> {
  await sourcePage().getByTestId("theme").focus();
  await application.evaluate(async ({ webContents }) => {
    const candidates = webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith("http://127.0.0.1:4175"));
    let source: (typeof candidates)[number] | undefined;
    for (const candidate of candidates) {
      if (await candidate.executeJavaScript("innerWidth") === 1440) { source = candidate; break; }
    }
    if (!source) throw new Error("desktop source pane missing");
    await source.debugger.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "ArrowDown", code: "ArrowDown" });
    await source.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown" });
    await source.debugger.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter" });
    await source.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  });
}

async function scrollSource(): Promise<void> {
  const surface = await chrome.locator('[data-pane-surface="desktop-1440"]').boundingBox();
  if (!surface) throw new Error("desktop source surface missing");
  const scale = Math.min(1, surface.width / 1440, surface.height / 900);
  await application.evaluate(async ({ webContents }, inputScale) => {
    const candidates = webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith("http://127.0.0.1:4175"));
    let source: (typeof candidates)[number] | undefined;
    for (const candidate of candidates) {
      if (await candidate.executeJavaScript("innerWidth") === 1440) { source = candidate; break; }
    }
    if (!source) throw new Error("desktop source pane missing");
    const box = await source.executeJavaScript(`document.querySelector('[data-testid="scroller"]').getBoundingClientRect().toJSON()`);
    await source.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseWheel", x: (box.x + box.width / 2) * inputScale, y: (box.y + box.height / 2) * inputScale, deltaX: 0, deltaY: 1000 });
  }, scale);
}

beforeAll(async () => {
  fixture = spawn(process.execPath, [resolve("tests/fixtures/server.mjs")], { env: { ...process.env, PORT: "4175" }, stdio: ["ignore", "pipe", "inherit"] });
  const ready = Promise.withResolvers<void>();
  fixture.stdout?.on("data", (data: Buffer) => { if (data.toString().includes("fixture ready")) ready.resolve(); });
  fixture.once("error", ready.reject);
  await ready.promise;
  userData = await mkdtemp(join(tmpdir(), "hoolypane-desktop-"));
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  environment.ELECTRON_ENABLE_LOGGING = "1";
  if (process.platform === "linux") environment.XDG_SESSION_TYPE = "x11";
  if (process.platform === "linux") delete environment.WAYLAND_DISPLAY;
  const graphicsArguments = process.platform === "linux" ? ["--ozone-platform=x11", "--use-gl=angle", "--use-angle=swiftshader"] : [];
  const electronExecutable = electronExecutablePath();
  application = await electron.launch({
    executablePath: electronExecutable,
    args: [...graphicsArguments, resolve("apps/desktop"), `--user-data-dir=${userData}`, "--url", "http://127.0.0.1:4175"],
    env: environment,
  });
  chrome = await application.firstWindow();
}, 30_000);

afterAll(async () => {
  await application?.close().catch(() => undefined);
  fixture?.kill("SIGTERM");
  if (userData) await rm(userData, { recursive: true, force: true });
});

describe("direct Electron surfaces", () => {
  it("creates direct emulated panes with hardened sessions and tears them down", async () => {
    await waitForPaneCount(5);
    const chromeText = await chrome.locator("body").innerText();
    expect(chromeText).toContain("Desktop 1440");
    const initial = await application.evaluate(async ({ webContents }) => Promise.all(webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith("http://127.0.0.1:4175")).map(async (contents) => contents.executeJavaScript(`(async () => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, touch: navigator.maxTouchPoints, permission: (await navigator.permissions.query({name:'geolocation'})).state }))()`))));
    expect(initial).toHaveLength(5);
    expect(initial.map((value) => [value.width, value.height, value.dpr])).toEqual(expect.arrayContaining([[1440, 900, 1], [1280, 800, 1], [768, 1024, 2], [390, 844, 3], [360, 800, 3]]));
    expect(initial.every((value) => value.permission === "denied")).toBe(true);
    await fillSource("Mirrored value");
    await waitForPaneState((snapshots) => snapshots.every((snapshot) => snapshot.name === "Mirrored value"), "fill");
    await clickSource("subscribe");
    await waitForPaneState((snapshots) => snapshots.every((snapshot) => snapshot.checked), "check");
    await selectSourceDark();
    await waitForPaneState((snapshots) => snapshots.every((snapshot) => snapshot.theme === "dark"), "select");
    await clickSource("apply");
    await waitForPaneState((snapshots) => snapshots.every((snapshot) => snapshot.status === "applied"), "click");
    await pressSourceEnter();
    await waitForPaneState((snapshots) => snapshots.every((snapshot) => snapshot.status === "entered"), "press");
    await scrollSource();
    await waitForPaneState((snapshots) => snapshots.every((snapshot) => snapshot.scrollRatio > 0.95), "scroll");

    await chrome.getByRole("button", { name: "Add custom" }).click();
    await waitForPaneCount(6);
    await chrome.getByRole("button", { name: "Rotate" }).first().click();
    await chrome.getByRole("button", { name: "Focus" }).first().click();
    await chrome.getByRole("button", { name: "Unfocus" }).first().click();
    await chrome.getByRole("button", { name: "Close" }).last().click();
    await waitForPaneCount(5);
  }, 60_000);
});
