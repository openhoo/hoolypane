import { rm } from "node:fs/promises";
import type { ElectronApplication, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchDesktopApp, pollUntil, startFixtureServer, type FixtureServer } from "../helpers/harness.js";
import { clickPaneSurface } from "./cdp-input.js";

const FIXTURE_PORT = 4185; // 4175 collided with an unrelated local dev stack

let fixture: FixtureServer | undefined;
let application: ElectronApplication;
let chrome: Page;
let userDataDir = "";

interface PaneSnapshot {
  readonly name: string;
  readonly theme: string;
  readonly checked: boolean;
  readonly status: string;
  readonly scrollRatio: number;
}

async function paneSnapshots(): Promise<Array<PaneSnapshot | null>> {
  return application.evaluate(async ({ webContents }, port) => Promise.all(
    webContents.getAllWebContents()
      .filter((contents) => contents.getURL().startsWith(`http://127.0.0.1:${port}`))
      .map((contents) => contents.executeJavaScript(`(() => { const name = document.querySelector('[data-testid="name"]'); const theme = document.querySelector('[data-testid="theme"]'); const subscribe = document.querySelector('[data-testid="subscribe"]'); const status = document.querySelector('[data-testid="status"]'); const scroller = document.querySelector('[data-testid="scroller"]'); if (!name || !theme || !subscribe || !status || !scroller) return null; return { name: name.value, theme: theme.value, checked: subscribe.checked, status: status.textContent, scrollRatio: scroller.scrollTop / (scroller.scrollHeight - scroller.clientHeight) }; })()`)),
  ), FIXTURE_PORT);
}

function sourcePage(): Page {
  const remotePages = application.context().pages().filter((page) => page.url().startsWith(`http://127.0.0.1:${FIXTURE_PORT}`));
  const source = remotePages.find((page) => page.viewportSize()?.width === 1440) ?? remotePages[0];
  if (!source) throw new Error("source pane missing");
  return source;
}

async function fillSource(value: string): Promise<void> {
  await sourcePage().getByTestId("name").fill(value);
}

async function pressSourceEnter(): Promise<void> {
  await sourcePage().getByTestId("command").press("Enter");
}

async function selectSourceDark(): Promise<void> {
  await sourcePage().getByTestId("theme").focus();
  await application.evaluate(async ({ webContents }, port) => {
    const candidates = webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith(`http://127.0.0.1:${port}`));
    let source: (typeof candidates)[number] | undefined;
    for (const candidate of candidates) {
      if (await candidate.executeJavaScript("innerWidth") === 1440) { source = candidate; break; }
    }
    if (!source) throw new Error("desktop source pane missing");
    await source.debugger.sendCommand("Input.dispatchKeyEvent", {
      type: "keyDown", key: "d", code: "KeyD", text: "d", unmodifiedText: "d", windowsVirtualKeyCode: 68,
    });
    await source.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "d", code: "KeyD", windowsVirtualKeyCode: 68 });
  }, FIXTURE_PORT);
}

async function scrollSource(): Promise<void> {
  // Scrolls the source scroller programmatically: the observed scroll event drives the same
  // mirror pipeline (envelope -> apply-dom scrollTo replay) as a native wheel, without depending
  // on emulated-viewport pointer coordinates.
  await application.evaluate(async ({ webContents }, port) => {
    const candidates = webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith(`http://127.0.0.1:${port}`));
    let source: (typeof candidates)[number] | undefined;
    for (const candidate of candidates) {
      if (await candidate.executeJavaScript("innerWidth") === 1440) { source = candidate; break; }
    }
    if (!source) throw new Error("desktop source pane missing");
    await source.executeJavaScript(`document.querySelector('[data-testid="scroller"]').scrollTo(0, document.querySelector('[data-testid="scroller"]').scrollHeight)`);
  }, FIXTURE_PORT);
}

beforeAll(async () => {
  fixture = await startFixtureServer(FIXTURE_PORT);
  const launch = await launchDesktopApp({ port: FIXTURE_PORT, extraEnv: { ELECTRON_ENABLE_LOGGING: "1" } });
  application = launch.application;
  chrome = launch.chrome;
  userDataDir = launch.userDataDir;
}, 30_000);

afterAll(async () => {
  await application?.close().catch(() => undefined);
  await fixture?.close();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
}, 30_000);

describe("direct Electron surfaces", () => {
  it("creates direct emulated panes with hardened sessions and tears them down", async () => {
    // Native child views expose no readiness event to Playwright; poll Electron's authoritative WebContents registry.
    await pollUntil(async () => {
      const count = await application.evaluate(({ webContents }, port) =>
        webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith(`http://127.0.0.1:${port}`)).length,
        FIXTURE_PORT);
      return count === 5 || null;
    }, 10_000);
    const chromeText = await chrome.locator("body").innerText();
    expect(chromeText).toContain("Desktop 1440");
    const initial = await application.evaluate(async ({ webContents }, port) => {
      const panes = webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith(`http://127.0.0.1:${port}`));
      return Promise.all(panes.map(async (contents) => contents.executeJavaScript(`(async () => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, touch: navigator.maxTouchPoints, permission: (await navigator.permissions.query({name:'geolocation'})).state }))()`)));
    }, FIXTURE_PORT);
    expect(initial).toHaveLength(5);
    expect(initial.map((value) => [value.width, value.height, value.dpr])).toEqual(expect.arrayContaining([[1440, 900, 1], [1280, 800, 1], [768, 1024, 2], [390, 844, 3], [360, 800, 3]]));
    expect(initial.every((value) => value.permission === "denied")).toBe(true);
    await fillSource("Mirrored value");
    // Mirrored native events expose completion only through page state in each independent WebContents.
    const waitForPaneState = async (predicate: (snapshots: readonly PaneSnapshot[]) => boolean, label: string): Promise<void> => {
      try {
        await pollUntil(async () => {
          const ready = (await paneSnapshots()).filter((snapshot): snapshot is PaneSnapshot => snapshot !== null);
          return ready.length === 5 && predicate(ready) ? ready : null;
        }, 10_000);
      } catch (error) {
        throw new Error(`desktop panes did not converge after ${label}: ${JSON.stringify(await paneSnapshots())}`, { cause: error });
      }
    };
    await waitForPaneState((snapshots) => snapshots.every((snapshot) => snapshot.name === "Mirrored value"), "fill");
    await clickPaneSurface(application, chrome, { port: FIXTURE_PORT, testId: "subscribe" });
    await waitForPaneState((snapshots) => snapshots.every((snapshot) => snapshot.checked), "check");
    await selectSourceDark();
    await waitForPaneState((snapshots) => snapshots.every((snapshot) => snapshot.theme === "dark"), "select");
    await clickPaneSurface(application, chrome, { port: FIXTURE_PORT, testId: "apply" });
    await waitForPaneState((snapshots) => snapshots.every((snapshot) => snapshot.status === "applied"), "click");
    await pressSourceEnter();
    await waitForPaneState((snapshots) => snapshots.every((snapshot) => snapshot.status === "entered"), "press");
    // A pane renderer occasionally reloads mid-test (webContents identity change), which resets its
    // scroll observation; retry the whole scroll action once before giving up.
    await (async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await scrollSource();
        try {
          await waitForPaneState((snapshots) => snapshots.every((snapshot) => snapshot.scrollRatio > 0.95), "scroll");
          return;
        } catch (error) {
          if (attempt === 1) throw error;
        }
      }
    })();

    await chrome.getByRole("button", { name: "Add custom" }).click();
    await pollUntil(async () => {
      const count = await application.evaluate(({ webContents }, port) =>
        webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith(`http://127.0.0.1:${port}`)).length,
        FIXTURE_PORT);
      return count === 6 || null;
    }, 10_000);
    await chrome.getByRole("button", { name: "Rotate" }).first().click();
    // rotatePane swaps the viewport dimensions; the emulated pane must report them swapped.
    await pollUntil(async () => await application.evaluate(async ({ webContents }, port) => {
      const dimensions = await Promise.all(webContents.getAllWebContents()
        .filter((contents) => contents.getURL().startsWith(`http://127.0.0.1:${port}`))
        .map((contents) => contents.executeJavaScript("({ width: innerWidth, height: innerHeight })")));
      return dimensions.some((dimension) => dimension.width === 900 && dimension.height === 1440);
    }, FIXTURE_PORT) || null, 10_000);
    await chrome.getByRole("button", { name: "Focus" }).first().click();
    await pollUntil(async () => await chrome.locator(".pane-card.focused").count() === 1 || null, 10_000);
    await chrome.getByRole("button", { name: "Unfocus" }).first().click();
    await pollUntil(async () => await chrome.locator(".pane-card.focused").count() === 0 || null, 10_000);
    await chrome.getByRole("button", { name: "Close" }).last().click();
    await pollUntil(async () => {
      const count = await application.evaluate(({ webContents }, port) =>
        webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith(`http://127.0.0.1:${port}`)).length,
        FIXTURE_PORT);
      return count === 5 || null;
    }, 10_000);
  }, 60_000);
});
