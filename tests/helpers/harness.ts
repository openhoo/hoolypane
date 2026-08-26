import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { electronExecutablePath } from "../electron-executable.js";
import { LINUX_SOFTWARE_RENDERING_ARGS, REPO_ROOT, type FixtureServer } from "./desktop-runtime.js";
import { errorMessage, VIEWPORT_PRESETS } from "@hoolypane/contracts";
import { fixtureOrigin } from "../fixtures/ports.js";
export { startFixtureServer, type FixtureServer } from "./desktop-runtime.js";


const desktopPreset = VIEWPORT_PRESETS.find((preset) => preset.id === "desktop-1440");
if (!desktopPreset) throw new Error("desktop-1440 preset missing");
/** Desktop pane width, kept in lockstep with integration/cdp-input.ts's clickPaneSurface scale math. */
const DESKTOP_PANE_WIDTH = desktopPreset.width;

/** Polls fn until it returns a value other than null, undefined, or false, or the timeout elapses. */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  intervalMs = 20,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let latest: T | undefined;
  while (Date.now() < deadline) {
    latest = await fn();
    if (latest !== null && latest !== undefined && latest !== false) return latest as NonNullable<T>;
    await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, intervalMs));
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms (last observation: ${JSON.stringify(latest)})`);
}

/** Counts fixture-origin WebContents through Electron's authoritative registry. */
export async function fixturePaneCount(application: ElectronApplication, port: number): Promise<number> {
  return application.evaluate(({ webContents }, origin) =>
    webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith(origin)).length,
  fixtureOrigin(port));
}

/** Polls until exactly `expected` fixture panes exist in Electron's WebContents registry. */
export async function waitForFixturePanes(
  application: ElectronApplication,
  port: number,
  expected: number,
  timeoutMs = 10_000,
): Promise<void> {
  await pollUntil(async () => await fixturePaneCount(application, port) === expected ? expected : null, timeoutMs);
}

/** Retries an action once when a transient renderer reload invalidates its execution context mid-run. */
export async function withReloadRetry<T>(label: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (firstError) {
    try {
      return await action();
    } catch (error) {
      throw new Error(`${label} failed on retry (first attempt: ${errorMessage(firstError)})`, { cause: error });
    }
  }
}

/**
 * Enumerates the fixture server's Playwright pages. Without `path`, every page whose URL
 * starts with the fixture origin matches; with `path`, only the exact `${origin}${path}`
 * URL matches, preserving each suite's fuzzy-vs-strict enumeration semantics.
 */
export function fixturePages(application: ElectronApplication, port: number, path?: string): Page[] {
  const origin = fixtureOrigin(port);
  return application.context().pages().filter((page) => path === undefined ? page.url().startsWith(origin) : page.url() === `${origin}${path}`);
}

/** Picks the pane whose viewport width equals `width` (the desktop-1440 source pane), falling back to the first page. */
export function locateSourcePane(pages: readonly Page[], width = DESKTOP_PANE_WIDTH): Page | undefined {
  return pages.find((page) => page.viewportSize()?.width === width) ?? pages[0];
}

interface DesktopLaunch {
  readonly application: ElectronApplication;
  readonly chrome: Page;
  /** Temporary directory backing the app profile; remove it during teardown. */
  readonly userDataDir: string;
}

interface LaunchDesktopAppOptions {
  /** Port of an already-running tests/fixtures/server.mjs instance. */
  port: number;
  /** App-profile base directory; a fresh temporary one is created when omitted. */
  userDataDir?: string;
  /** Extra environment variables merged over the filtered parent environment. */
  extraEnv?: Readonly<Record<string, string>>;
}

/**
 * Launches the desktop app against the given fixture URL with the shared
 * graphics/env setup used by every integration suite, then returns its chrome window.
 */
export async function launchDesktopApp(options: LaunchDesktopAppOptions): Promise<DesktopLaunch> {
  const userDataDir = options.userDataDir ?? await mkdtemp(join(tmpdir(), "hoolypane-test-"));
  let application: ElectronApplication | undefined;
  try {
    // Drop the app's own HOOLYPANE_* namespace from the inherited parent environment: the
    // app's test-only knobs must come solely from options.extraEnv, so stray exports left in
    // the invoking shell (e.g. a leftover HOOLYPANE_TEST_MODE) can never alter suites that
    // did not opt in. Suites needing them set them explicitly via extraEnv.
    const environment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("HOOLYPANE_")),
    );
    Object.assign(environment, options.extraEnv);
    if (process.platform === "linux") {
      environment.XDG_SESSION_TYPE = "x11";
      delete environment.WAYLAND_DISPLAY;
    }
    const graphicsArguments =
      process.platform === "linux" ? LINUX_SOFTWARE_RENDERING_ARGS : [];
    application = await electron.launch({
      executablePath: electronExecutablePath(),
      args: [
        ...graphicsArguments,
        resolve(REPO_ROOT, "apps/desktop"),
        `--user-data-dir=${join(userDataDir, "user-data")}`,
        "--url",
        fixtureOrigin(options.port),
      ],
      env: environment,
    });
    const chrome = await application.firstWindow();
    return { application, chrome, userDataDir };
  } catch (error) {
    // Roll back a failed launch so no orphaned profile dir or Electron process survives.
    await application?.close().catch(() => {});
    if (options.userDataDir === undefined) await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}


/**
 * Shared integration-suite teardown: closes the app (tolerating a failed or
 * already-closed launch), stops the fixture server, and removes the temporary
 * app profile directory when one was created.
 */
export async function teardownDesktopSuite(
  application: ElectronApplication | undefined,
  fixture: FixtureServer | undefined,
  userDataDir: string,
): Promise<void> {
  await application?.close().catch(() => undefined);
  await fixture?.close();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => undefined);
}