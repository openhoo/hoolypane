import { BrowserWindow, dialog } from "electron";
import { Worker } from "node:worker_threads";
import { extname, isAbsolute } from "node:path";
import { writeFileAtomic } from "../persistence/workspace-store.js";
import type { PaneRegistry } from "../panes/pane-registry.js";
import type { OverviewInput, OverviewTileInput, OverviewWorkerResponse } from "./overview-protocol.js";

function testOutputPath(variable: "HOOLYPANE_TEST_PANE_PNG" | "HOOLYPANE_TEST_OVERVIEW_PNG"): string | undefined {
  if (process.env.HOOLYPANE_TEST_MODE !== "1") return undefined;
  const value = process.env[variable];
  if (!value) return undefined;
  if (!isAbsolute(value) || extname(value).toLowerCase() !== ".png") throw new Error(`${variable} must be an absolute PNG path`);
  return value;
}

/** Shared screenshot tail: test-override path first, else a save dialog; encodes exactly once upstream. */
async function savePng(
  window: BrowserWindow,
  png: Uint8Array,
  testVariable: "HOOLYPANE_TEST_PANE_PNG" | "HOOLYPANE_TEST_OVERVIEW_PNG",
  title: string,
  defaultPath: string,
): Promise<void> {
  const directPath = testOutputPath(testVariable);
  if (directPath) {
    await writeFileAtomic(directPath, png);
    return;
  }
  const selection = await dialog.showSaveDialog(window, {
    title,
    defaultPath,
    filters: [{ name: "PNG image", extensions: ["png"] }],
  });
  if (!selection.canceled && selection.filePath) await writeFileAtomic(selection.filePath, png);
}

export async function capturePane(window: BrowserWindow, registry: PaneRegistry, paneId: string): Promise<void> {
  const pane = registry.getPane(paneId);
  const state = registry.getPaneState(paneId);
  if (!pane || !state) throw new Error(`unknown pane: ${paneId}`);
  const png = (await pane.view.webContents.capturePage()).toPNG();
  await savePng(window, png, "HOOLYPANE_TEST_PANE_PNG", `Save ${state.name} screenshot`, `${state.id}.png`);
}

export async function captureOverview(window: BrowserWindow, registry: PaneRegistry): Promise<void> {
  const workspace = registry.getState();
  const tiles = await Promise.all(workspace.order.map(async (paneId) => {
    const pane = registry.getPane(paneId);
    const state = registry.getPaneState(paneId);
    try {
      if (!pane || !state) throw new Error("pane closed before capture");
      const image = await pane.view.webContents.capturePage();
      return { name: state.name, dimensions: `${state.viewport.width}×${state.viewport.height} @${state.viewport.deviceScaleFactor}`, png: image.toPNG() };
    } catch (error) {
      const name = state?.name ?? paneId;
      const dimensions = `${state?.viewport.width ?? 0}×${state?.viewport.height ?? 0}@${state?.viewport.deviceScaleFactor ?? 1}`;
      return { name, dimensions, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  const png = await composeOverview(tiles, "#111318");
  await savePng(window, png, "HOOLYPANE_TEST_OVERVIEW_PNG", "Save Hoolypane overview", "hoolypane-overview.png");
}

function composeOverview(tiles: readonly OverviewTileInput[], background: string): Promise<Buffer> {
  const worker = new Worker(new URL("./overview-worker.js", import.meta.url), { workerData: { tiles, background } satisfies OverviewInput });
  const result = Promise.withResolvers<Buffer>();
  worker.once("message", (value: OverviewWorkerResponse) => {
    if (value.ok) result.resolve(Buffer.from(value.png));
    else result.reject(new Error(value.error));
  });
  worker.once("error", result.reject);
  worker.once("exit", (code) => { if (code !== 0) result.reject(new Error(`overview worker exited ${code}`)); });
  return result.promise.finally(() => void worker.terminate());
}
