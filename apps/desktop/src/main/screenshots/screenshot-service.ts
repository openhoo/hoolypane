import { BrowserWindow, dialog } from "electron";
import { Worker } from "node:worker_threads";
import { extname, isAbsolute } from "node:path";
import { DEFAULT_COMPOSITE_BACKGROUND, errorMessage, formatViewportDimensions } from "@hoolypane/contracts";
import { writeFileAtomic } from "@hoolypane/contracts/fsync";
import { testModeEnabled, TEST_OVERVIEW_PNG_ENV, TEST_PANE_PNG_ENV } from "../test-env.js";
import type { PaneRegistry } from "../panes/pane-registry.js";
import { unknownPaneMessage } from "../panes/workspace.js";
import type { OverviewInput, OverviewTileInput, OverviewWorkerResponse } from "./overview-protocol.js";

/** Test-only file override shared by E2E hooks: test-mode gating via testModeEnabled, env read, absolute-<label>-path validation. */
export function testEnvFilePath(variable: string, extension: string, label: string): string | undefined {
  if (!testModeEnabled()) return undefined;
  const value = process.env[variable];
  if (!value) return undefined;
  if (!isAbsolute(value) || extname(value).toLowerCase() !== extension) throw new Error(`${variable} must be an absolute ${label} path`);
  return value;
}

/** Shared dialog-save tail: show a native save dialog and write on acceptance; cancellation collapses silently. */
export async function saveViaDialog(
  window: BrowserWindow,
  contents: string | Uint8Array,
  options: { title: string; defaultPath: string; filterName: string; extension: string },
): Promise<void> {
  const selection = await dialog.showSaveDialog(window, {
    title: options.title,
    defaultPath: options.defaultPath,
    filters: [{ name: options.filterName, extensions: [options.extension] }],
  });
  if (!selection.canceled && selection.filePath) await writeFileAtomic(selection.filePath, contents);
}

/** Shared screenshot tail: test-override path first, else a save dialog; encodes exactly once upstream. */
async function savePng(
  window: BrowserWindow,
  png: Uint8Array,
  testVariable: typeof TEST_PANE_PNG_ENV | typeof TEST_OVERVIEW_PNG_ENV,
  title: string,
  defaultPath: string,
): Promise<void> {
  const directPath = testEnvFilePath(testVariable, ".png", "PNG");
  if (directPath) {
    await writeFileAtomic(directPath, png);
    return;
  }
  await saveViaDialog(window, png, { title, defaultPath, filterName: "PNG image", extension: "png" });
}

export async function capturePane(window: BrowserWindow, registry: PaneRegistry, paneId: string): Promise<void> {
  const pane = registry.getPane(paneId);
  const state = registry.getPaneState(paneId);
  if (!pane || !state) throw new Error(unknownPaneMessage(paneId));
  const png = (await pane.view.webContents.capturePage()).toPNG();
  await savePng(window, png, TEST_PANE_PNG_ENV, `Save ${state.name} screenshot`, `${state.id}.png`);
}

export async function captureOverview(window: BrowserWindow, registry: PaneRegistry): Promise<void> {
  const workspace = registry.getState();
  const tiles = await Promise.all(workspace.order.map(async (paneId) => {
    const pane = registry.getPane(paneId);
    const state = registry.getPaneState(paneId);
    if (!pane || !state) return { name: state?.name ?? paneId, dimensions: formatViewportDimensions(state?.viewport ?? { width: 0, height: 0, deviceScaleFactor: 1 }), error: "pane closed before capture" };
    const name = state.name;
    const dimensions = formatViewportDimensions(state.viewport);
    try {
      const image = await pane.view.webContents.capturePage();
      return { name, dimensions, png: image.toPNG() };
    } catch (error) {
      return { name, dimensions, error: errorMessage(error) };
    }
  }));
  const png = await composeOverview(tiles, DEFAULT_COMPOSITE_BACKGROUND);
  await savePng(window, png, TEST_OVERVIEW_PNG_ENV, "Save Hoolypane overview", "hoolypane-overview.png");
}

/** Watchdog deadline for one overview composition: equal to QUIT_FLUSH_DEADLINE_MS (main/index.ts)
 *  and CHILD_GRACE_MS (@hoolypane/contracts recorder capture-contract); same async-boundary watchdog
 *  class as REPLAY_RESULT_TIMEOUT_MS (5s) and the fixture-server readiness kill, at the longer 10s
 *  tier. Generous against measured ms-scale composes, and capped at the quit-drain deadline it
 *  must never outlast. */
const OVERVIEW_COMPOSE_TIMEOUT_MS = 10_000;

/** Compose tiles off-thread on a fresh worker per call, terminated when the promise settles. The
 *  watchdog bounds a wedged sharp/libvips render: expiry terminates this worker instance and rejects,
 *  so queued chrome commands proceed; the next compose respawns under the unchanged per-call lifecycle.
 *  Late message/exit events after expiry are silent no-op double-settles on the resolvers. */
function composeOverview(tiles: readonly OverviewTileInput[], background: string): Promise<Uint8Array> {
  const worker = new Worker(new URL("./overview-worker.js", import.meta.url), { workerData: { tiles, background } satisfies OverviewInput });
  const result = Promise.withResolvers<Uint8Array>();
  const watchdog = setTimeout(() => {
    void worker.terminate();
    result.reject(new Error(`overview composition did not finish within ${OVERVIEW_COMPOSE_TIMEOUT_MS}ms`));
  }, OVERVIEW_COMPOSE_TIMEOUT_MS);
  worker.once("message", (value: OverviewWorkerResponse) => {
    if (value.ok) result.resolve(value.png);
    else result.reject(new Error(value.error));
  });
  worker.once("error", result.reject);
  worker.once("exit", (code) => { if (code !== 0) result.reject(new Error(`overview worker exited ${code}`)); });
  return result.promise.finally(() => {
    clearTimeout(watchdog);
    void worker.terminate();
  });
}
