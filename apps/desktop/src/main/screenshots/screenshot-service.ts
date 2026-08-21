import { BrowserWindow, dialog } from "electron";
import { promises as fs } from "node:fs";
import { Worker } from "node:worker_threads";
import type { PaneRegistry } from "../panes/pane-registry.js";

interface WorkerResponse {
  readonly ok: boolean;
  readonly png?: Uint8Array;
  readonly error?: string;
}

export async function capturePane(window: BrowserWindow, registry: PaneRegistry, paneId: string): Promise<void> {
  const pane = registry.getPane(paneId);
  const state = registry.getPaneState(paneId);
  if (!pane || !state) throw new Error(`unknown pane: ${paneId}`);
  const image = await pane.view.webContents.capturePage();
  const selection = await dialog.showSaveDialog(window, {
    title: `Save ${state.name} screenshot`,
    defaultPath: `${state.id}.png`,
    filters: [{ name: "PNG image", extensions: ["png"] }],
  });
  if (!selection.canceled && selection.filePath) await fs.writeFile(selection.filePath, image.toPNG());
}

export async function captureOverview(window: BrowserWindow, registry: PaneRegistry): Promise<void> {
  const workspace = registry.getState();
  const tiles = await Promise.all(workspace.order.map(async (paneId) => {
    const pane = registry.getPane(paneId);
    const state = registry.getPaneState(paneId)!;
    try {
      if (!pane) throw new Error("pane closed before capture");
      const image = await pane.view.webContents.capturePage();
      return { name: state.name, dimensions: `${state.viewport.width}×${state.viewport.height} @${state.viewport.deviceScaleFactor}`, png: image.toPNG() };
    } catch (error) {
      return { name: state.name, dimensions: `${state.viewport.width}×${state.viewport.height} @${state.viewport.deviceScaleFactor}`, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  const png = await composeOverview(tiles, "#111318");
  const selection = await dialog.showSaveDialog(window, {
    title: "Save Hoolypane overview",
    defaultPath: "hoolypane-overview.png",
    filters: [{ name: "PNG image", extensions: ["png"] }],
  });
  if (!selection.canceled && selection.filePath) await fs.writeFile(selection.filePath, png);
}

function composeOverview(tiles: readonly { name: string; dimensions: string; png?: Uint8Array; error?: string }[], background: string): Promise<Buffer> {
  const worker = new Worker(new URL("./overview-worker.js", import.meta.url), { workerData: { tiles, background } });
  const result = Promise.withResolvers<Buffer>();
  worker.once("message", (value: WorkerResponse) => {
    if (value.ok && value.png) result.resolve(Buffer.from(value.png));
    else result.reject(new Error(value.error ?? "overview worker failed"));
  });
  worker.once("error", result.reject);
  worker.once("exit", (code) => { if (code !== 0) result.reject(new Error(`overview worker exited ${code}`)); });
  return result.promise.finally(() => void worker.terminate());
}
