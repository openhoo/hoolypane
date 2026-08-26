import { BrowserWindow, dialog } from "electron";
import { Worker } from "node:worker_threads";
import { extname, isAbsolute } from "node:path";
import { DEFAULT_COMPOSITE_BACKGROUND, errorMessage, formatViewportDimensions } from "@hoolypane/contracts";
import { writeFileAtomic } from "@hoolypane/contracts/fsync";
import type { PaneRegistry } from "../panes/pane-registry.js";
import { unknownPaneMessage } from "../panes/workspace.js";
import type { OverviewInput, OverviewTileInput, OverviewWorkerResponse } from "./overview-protocol.js";

/** Test-only file override shared by E2E hooks: HOOLYPANE_TEST_MODE gate, env read, absolute-<label>-path validation. */
export function testEnvFilePath(variable: string, extension: string, label: string): string | undefined {
  if (process.env.HOOLYPANE_TEST_MODE !== "1") return undefined;
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
  testVariable: "HOOLYPANE_TEST_PANE_PNG" | "HOOLYPANE_TEST_OVERVIEW_PNG",
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
  await savePng(window, png, "HOOLYPANE_TEST_PANE_PNG", `Save ${state.name} screenshot`, `${state.id}.png`);
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
  await savePng(window, png, "HOOLYPANE_TEST_OVERVIEW_PNG", "Save Hoolypane overview", "hoolypane-overview.png");
}

function composeOverview(tiles: readonly OverviewTileInput[], background: string): Promise<Uint8Array> {
  const worker = new Worker(new URL("./overview-worker.js", import.meta.url), { workerData: { tiles, background } satisfies OverviewInput });
  const result = Promise.withResolvers<Uint8Array>();
  worker.once("message", (value: OverviewWorkerResponse) => {
    if (value.ok) result.resolve(value.png);
    else result.reject(new Error(value.error));
  });
  worker.once("error", result.reject);
  worker.once("exit", (code) => { if (code !== 0) result.reject(new Error(`overview worker exited ${code}`)); });
  return result.promise.finally(() => void worker.terminate());
}
