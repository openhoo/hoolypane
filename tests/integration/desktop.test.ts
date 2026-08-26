import type { ElectronApplication, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixturePages, launchDesktopApp, locateSourcePane, pollUntil, startFixtureServer, teardownDesktopSuite, waitForFixturePanes, type FixtureServer } from "../helpers/harness.js";
import { errorMessage, IPC_CHANNELS } from "@hoolypane/contracts";
import { clickPaneSurface } from "./cdp-input.js";
import { FIXTURE_PORTS } from "../fixtures/ports.js";

// 4175 collided with an unrelated local dev stack; port assignment lives centrally now.
const FIXTURE_PORT = FIXTURE_PORTS.desktop;

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
  const source = locateSourcePane(fixturePages(application, FIXTURE_PORT));
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
  await sourcePage().keyboard.press("d");
}

async function scrollSource(): Promise<void> {
  // Scrolls the source scroller programmatically: the observed scroll event drives the same
  // mirror pipeline (envelope -> apply-dom scrollTo replay) as a native wheel, without depending
  // on emulated-viewport pointer coordinates.
  await sourcePage().getByTestId("scroller").evaluate((element) => element.scrollTo(0, element.scrollHeight));
}

beforeAll(async () => {
  fixture = await startFixtureServer(FIXTURE_PORT);
  const launch = await launchDesktopApp({ port: FIXTURE_PORT, extraEnv: { ELECTRON_ENABLE_LOGGING: "1" } });
  application = launch.application;
  chrome = launch.chrome;
  userDataDir = launch.userDataDir;
}, 30_000);

afterAll(() => teardownDesktopSuite(application, fixture, userDataDir), 30_000);

describe("direct Electron surfaces", () => {
  it("receives published state through the preload stateRequest pull handshake", async () => {
    // Pane cards can only render from a received ChromeState snapshot, so their presence
    // plus a populated address input proves the renderer got published state after launch.
    await pollUntil(async () => (await chrome.locator(".pane-card").count()) === 5 || null, 15_000);
    await pollUntil(async () => (await chrome.locator("#address").inputValue()).startsWith(`http://127.0.0.1:${FIXTURE_PORT}`) || null, 10_000);

    // Regression pin for the lost-initial-push bug: subscribe() must PULL state via
    // stateRequest exactly once per subscription. A fresh chrome reload is one clean
    // subscription cycle observed through a main-side counter.
    await application.evaluate(({ ipcMain }, channel) => {
      const state = globalThis as typeof globalThis & { __stateRequestCount?: number };
      if (state.__stateRequestCount === undefined) {
        state.__stateRequestCount = 0;
        ipcMain.on(channel, () => { state.__stateRequestCount += 1; });
      }
      state.__stateRequestCount = 0;
    }, IPC_CHANNELS.stateRequest);
    await chrome.evaluate(() => location.reload());
    await pollUntil(async () => (await chrome.locator(".pane-card").count()) === 5 || null, 15_000);
    await pollUntil(async () => (await chrome.locator("#address").inputValue()).startsWith(`http://127.0.0.1:${FIXTURE_PORT}`) || null, 10_000);
    const stateRequests = await application.evaluate(() => (globalThis as typeof globalThis & { __stateRequestCount?: number }).__stateRequestCount ?? -1);
    expect(stateRequests).toBe(1);
  }, 30_000);

  it("creates direct emulated panes with hardened sessions and tears them down", async () => {
    // Native child views expose no readiness event to Playwright; poll Electron's authoritative WebContents registry.
    await waitForFixturePanes(application, FIXTURE_PORT, 5);
    const chromeText = await chrome.locator("body").innerText();
    expect(chromeText).toContain("Desktop 1440");
    const initial = await application.evaluate(async ({ webContents }, port) => {
      const panes = webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith(`http://127.0.0.1:${port}`));
      return Promise.all(panes.map(async (contents) => contents.executeJavaScript(`(async () => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, touch: navigator.maxTouchPoints, permission: (await navigator.permissions.query({name:'geolocation'})).state }))()`)));
    }, FIXTURE_PORT);
    expect(initial).toHaveLength(5);
    expect(initial.map((value) => [value.width, value.height, value.dpr])).toEqual(expect.arrayContaining([[1440, 900, 1], [1280, 800, 1], [768, 1024, 2], [390, 844, 3], [360, 800, 3]]));
    expect(initial.every((value) => value.permission === "denied")).toBe(true);
    // Mirrored native events expose completion only through page state in each independent WebContents.
    const waitForPaneState = async (predicate: (snapshots: readonly PaneSnapshot[]) => boolean, label: string): Promise<void> => {
      try {
        await pollUntil(async () => {
          let snapshots: Array<PaneSnapshot | null>;
          try {
            snapshots = await paneSnapshots();
          } catch {
            // A transient renderer reload invalidates execution contexts mid-poll; retry instead of aborting.
            return null;
          }
          const ready = snapshots.filter((snapshot): snapshot is PaneSnapshot => snapshot !== null);
          return ready.length === 5 && predicate(ready) ? ready : null;
        }, 10_000);
      } catch (error) {
        throw new Error(`desktop panes did not converge after ${label}: ${JSON.stringify(await paneSnapshots().catch(() => []))}`, { cause: error });
      }
    };
    // A pane renderer occasionally reloads mid-test (webContents identity change), which
    // invalidates execution contexts or drops in-flight mirrored input; retry the whole
    // action together with its convergence poll once before giving up.
    const withReloadRetry = async (label: string, action: () => Promise<void>, predicate: (snapshots: readonly PaneSnapshot[]) => boolean): Promise<void> => {
      let firstError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await action();
          await waitForPaneState(predicate, label);
          return;
        } catch (error) {
          if (attempt === 1) throw new Error(`${label} failed on retry (first attempt: ${errorMessage(firstError)})`, { cause: error });
          firstError = error;
        }
      }
    };
    await withReloadRetry("fill", () => fillSource("Mirrored value"), (snapshots) => snapshots.every((snapshot) => snapshot.name === "Mirrored value"));
    await withReloadRetry("check", () => clickPaneSurface(application, chrome, { port: FIXTURE_PORT, testId: "subscribe" }), (snapshots) => snapshots.every((snapshot) => snapshot.checked));
    await withReloadRetry("select", selectSourceDark, (snapshots) => snapshots.every((snapshot) => snapshot.theme === "dark"));
    await withReloadRetry("click", () => clickPaneSurface(application, chrome, { port: FIXTURE_PORT, testId: "apply", expectedStatus: "applied" }), (snapshots) => snapshots.every((snapshot) => snapshot.status === "applied"));
    await withReloadRetry("press", pressSourceEnter, (snapshots) => snapshots.every((snapshot) => snapshot.status === "entered"));
    await withReloadRetry("scroll", scrollSource, (snapshots) => snapshots.every((snapshot) => snapshot.scrollRatio > 0.95));

    await chrome.getByRole("button", { name: "Add custom" }).click();
    await waitForFixturePanes(application, FIXTURE_PORT, 6);
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
    await waitForFixturePanes(application, FIXTURE_PORT, 5);
  }, 60_000);
});
