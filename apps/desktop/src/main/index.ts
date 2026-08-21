import { app, BrowserWindow, dialog, ipcMain, type IpcMainEvent } from "electron";
import { promises as fs } from "node:fs";
import { dirname, extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActionEnvelopeSchema,
  BoundsSnapshotSchema,
  ChromeCommandSchema,
  IPC_CHANNELS,
  PaneObservedActionSchema,
  ReplayResultSchema,
  type ActionEnvelope,
  type ChromeCommand,
  type ReplayRequest,
  type ReplayResult,
} from "@hoolypane/contracts";
import { FlowDraft } from "./interactions/flow-draft.js";
import { InteractionCoordinator } from "./interactions/interaction-coordinator.js";
import { PaneRegistry } from "./panes/pane-registry.js";
import { normalizeUrl } from "./panes/url.js";
import { loadWorkspace, saveWorkspace } from "./persistence/workspace-store.js";
import { captureOverview, capturePane } from "./screenshots/screenshot-service.js";

let chromeWindow: BrowserWindow | undefined;
let registry: PaneRegistry | undefined;
let workspacePath = "";
let nextActionId = 1;
const coordinator = new InteractionCoordinator();
const flowDraft = new FlowDraft();
const pendingReplay = new Map<string, { resolve: (result: ReplayResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function trustedChrome(event: IpcMainEvent): boolean {
  return chromeWindow !== undefined && event.sender === chromeWindow.webContents && event.senderFrame === chromeWindow.webContents.mainFrame;
}

function sourcePane(event: IpcMainEvent): string | undefined {
  if (event.senderFrame !== event.sender.mainFrame) return undefined;
  return registry?.paneIdForWebContents(event.sender);
}

function publishState(): void {
  if (chromeWindow && registry) chromeWindow.webContents.send(IPC_CHANNELS.state, { ...registry.getState(), recording: flowDraft.isActive });
}

function report(paneId: string, message: string): void {
  chromeWindow?.webContents.send(IPC_CHANNELS.paneEvent, { paneId, message });
}
function testFlowSavePath(): string | undefined {
  if (process.env.HOOLYPANE_TEST_MODE !== "1") return undefined;
  if (process.env.HOOLYPANE_TEST_FLOW_SAVE_CANCEL === "1") return "";
  const value = process.env.HOOLYPANE_TEST_FLOW_PATH;
  if (!value) return undefined;
  if (!isAbsolute(value) || extname(value).toLowerCase() !== ".ts") throw new Error("HOOLYPANE_TEST_FLOW_PATH must be an absolute TypeScript path");
  return value;
}
async function applyTestReplayDelay(): Promise<void> {
  if (process.env.HOOLYPANE_TEST_MODE !== "1") return;
  const milliseconds = Number(process.env.HOOLYPANE_TEST_REPLAY_DELAY_MS ?? 0);
  if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 1_000) throw new Error("HOOLYPANE_TEST_REPLAY_DELAY_MS must be an integer from 0 to 1000");
  if (milliseconds === 0) return;
  const completion = Promise.withResolvers<void>();
  setTimeout(completion.resolve, milliseconds);
  await completion.promise;
}

async function stopAndSaveFlow(): Promise<void> {
  if (!registry || !chromeWindow) return;
  for (const record of registry.panes.values()) record.view.webContents.send(IPC_CHANNELS.flush);
  await new Promise((resolve) => setTimeout(resolve, 325));
  const source = flowDraft.stop();
  publishState();
  if (source === null) return;
  const directPath = testFlowSavePath();
  if (directPath === "") return;
  if (directPath) {
    await fs.writeFile(directPath, source, "utf8");
    return;
  }
  const selection = await dialog.showSaveDialog(chromeWindow, {
    title: "Save Hoolypane flow",
    defaultPath: "hoolypane-flow.ts",
    filters: [{ name: "TypeScript", extensions: ["ts"] }],
  });
  if (!selection.canceled && selection.filePath) await fs.writeFile(selection.filePath, source, { encoding: "utf8", flag: "wx" }).catch(async (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await fs.writeFile(selection.filePath!, source, "utf8");
  });
}

async function handleCommand(command: ChromeCommand): Promise<void> {
  if (!registry) return;
  switch (command.kind) {
    case "create": await registry.create(command.viewport); break;
    case "close": coordinator.cancelPane(command.paneId); await registry.close(command.paneId); break;
    case "duplicate": await registry.duplicate(command.paneId); break;
    case "rename": registry.rename(command.paneId, command.name); break;
    case "reorder": registry.reorder(command.paneId, command.index); break;
    case "resize": registry.resize(command.paneId, command.width, command.height); break;
    case "rotate": registry.rotate(command.paneId); break;
    case "focus": registry.focus(command.paneId); break;
    case "navigate": {
      for (const record of registry.panes.values()) record.view.webContents.send(IPC_CHANNELS.flush);
      await registry.navigate(command.url);
      break;
    }
    case "back": registry.back(command.paneId); break;
    case "forward": registry.forward(command.paneId); break;
    case "reload": registry.reload(command.paneId); break;
    case "set-layout": registry.setLayout(command.layout); break;
    case "set-sync": registry.setSync(command.enabled); break;
    case "record-start": {
      const firstPane = registry.getState().order[0];
      if (firstPane) flowDraft.start(registry.getState().sharedUrl, firstPane, nextActionId++, Date.now());
      break;
    }
    case "record-stop": await stopAndSaveFlow(); break;
    case "capture-pane": if (chromeWindow) await capturePane(chromeWindow, registry, command.paneId); break;
    case "capture-overview": if (chromeWindow) await captureOverview(chromeWindow, registry); break;
  }
  publishState();
  await saveWorkspace(workspacePath, registry.getState());
}

function replayKey(paneId: string, actionId: number, phase: ReplayRequest["phase"]): string {
  return `${paneId}:${actionId}:${phase}`;
}

function requestReplay(paneId: string, request: ReplayRequest): Promise<ReplayResult> {
  const record = registry?.getPane(paneId);
  if (!record) return Promise.reject(new Error(`pane closed: ${paneId}`));
  return new Promise((resolve, reject) => {
    const key = replayKey(paneId, request.actionId, request.phase);
    const timer = setTimeout(() => {
      pendingReplay.delete(key);
      reject(new Error(`pane ${paneId} timed out during ${request.phase}`));
    }, 5_000);
    pendingReplay.set(key, { resolve, reject, timer });
    record.view.webContents.send(IPC_CHANNELS.replay, request);
  });
}

async function applyCdp(paneId: string, envelope: ActionEnvelope, resolved: ReplayResult): Promise<void> {
  const record = registry?.getPane(paneId);
  const box = resolved.box;
  if (!record || !box) throw new Error("target did not provide an element box");
  const cdp = record.view.webContents.debugger;
  const scale = registry?.getInputScale(paneId) ?? 1;
  const x = (box.x + box.width / 2) * scale;
  const y = (box.y + box.height / 2) * scale;
  const click = async (): Promise<void> => {
    await cdp.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  const action = envelope.action;
  if (action.kind === "click") await click();
  else if (action.kind === "check") {
    if (resolved.checked !== action.checked) await click();
  } else if (action.kind === "fill") {
    await cdp.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", modifiers: process.platform === "darwin" ? 4 : 2 });
    await cdp.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: process.platform === "darwin" ? 4 : 2 });
    await cdp.sendCommand("Input.insertText", { text: action.value });
  } else if (action.kind === "press") {
    await cdp.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", key: action.key });
    await cdp.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: action.key });
  }
}

async function replayEnvelope(paneId: string, envelope: ActionEnvelope): Promise<void> {
  await applyTestReplayDelay();
  if (envelope.action.kind === "navigate") {
    await registry?.getPane(paneId)?.view.webContents.loadURL(envelope.action.url);
    return;
  }
  const request = { actionId: envelope.actionId, documentGeneration: envelope.documentGeneration, action: envelope.action } as const;
  try {
    if (envelope.action.kind === "select" || envelope.action.kind === "scroll") {
      const result = await requestReplay(paneId, { ...request, phase: "apply-dom" });
      if (!result.ok) throw new Error(result.reason ?? "DOM replay failed");
    } else {
      const result = await requestReplay(paneId, { ...request, phase: "resolve" });
      if (!result.ok) throw new Error(result.reason ?? "locator resolution failed");
      await applyCdp(paneId, envelope, result);
    }
  } finally {
    await requestReplay(paneId, { ...request, phase: "end" }).catch(() => undefined);
  }
}

async function acceptSourceAction(sourcePaneId: string, observed: unknown): Promise<void> {
  if (!registry) return;
  const source = PaneObservedActionSchema.parse(observed);
  const envelope = ActionEnvelopeSchema.parse({
    actionId: nextActionId++,
    documentGeneration: source.documentGeneration,
    sourcePaneId,
    action: source.action,
    recordedAtUnixMs: Date.now(),
  });
  flowDraft.append(envelope);
  if (!registry.getState().syncEnabled) return;
  const targets = registry.getState().order.filter((paneId) => paneId !== sourcePaneId);
  const outcomes = await coordinator.dispatch(envelope, targets, replayEnvelope);
  for (const outcome of outcomes) {
    if (outcome.ok) registry.clearOutOfSync(outcome.paneId);
    else {
      const reason = outcome.reason ?? "unknown replay failure";
      registry.markOutOfSync(outcome.paneId, envelope.actionId, envelope.action.kind, reason);
      flowDraft.block(envelope.actionId, `${outcome.paneId}: ${reason}`);
      report(outcome.paneId, reason);
    }
  }
  publishState();
}

async function createChrome(): Promise<void> {
  workspacePath = join(app.getPath("userData"), "workspace.json");
  let workspace = await loadWorkspace(workspacePath);
  const urlIndex = process.argv.indexOf("--url");
  const requestedUrl = urlIndex >= 0 ? process.argv[urlIndex + 1] : undefined;
  if (requestedUrl) {
    const normalized = normalizeUrl(requestedUrl);
    workspace = { ...workspace, sharedUrl: normalized, panes: workspace.panes.map((pane) => ({ ...pane, url: normalized })) };
  }
  chromeWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 720,
    minHeight: 600,
    show: false,
    webPreferences: { preload: fileURLToPath(new URL("../preload/chrome.js", import.meta.url)), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  registry = new PaneRegistry({ workspace, onChange: publishState, onFailure: (failure) => report(failure.paneId, failure.message) });
  registry.attachWindow(chromeWindow);
  ipcMain.on(IPC_CHANNELS.bounds, (event, value: unknown) => {
    if (!trustedChrome(event)) return;
    try { registry?.applyBounds(BoundsSnapshotSchema.parse(value)); } catch (error) { report("", error instanceof Error ? error.message : String(error)); }
  });
  ipcMain.on(IPC_CHANNELS.command, (event, value: unknown) => {
    if (!trustedChrome(event)) return;
    try { void handleCommand(ChromeCommandSchema.parse(value)).catch((error: unknown) => report("", error instanceof Error ? error.message : String(error))); } catch (error) { report("", error instanceof Error ? error.message : String(error)); }
  });
  ipcMain.on(IPC_CHANNELS.paneAction, (event, value: unknown) => {
    const paneId = sourcePane(event);
    if (!paneId) return;
    void acceptSourceAction(paneId, value).catch((error: unknown) => report(paneId, error instanceof Error ? error.message : String(error)));
  });
  ipcMain.on(IPC_CHANNELS.replayResult, (event, value: unknown) => {
    const paneId = sourcePane(event);
    if (!paneId) return;
    try {
      const parsed = ReplayResultSchema.parse(value);
      const key = replayKey(paneId, parsed.actionId, parsed.phase);
      const pending = pendingReplay.get(key);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingReplay.delete(key);
      pending.resolve({ ...parsed, paneId });
    } catch (error) { report(paneId, error instanceof Error ? error.message : String(error)); }
  });
  chromeWindow.once("ready-to-show", () => chromeWindow?.show());
  await chromeWindow.loadFile(join(dirname(fileURLToPath(import.meta.url)), "renderer/index.html"));
  for (const pane of workspace.panes) if (!registry.panes.has(pane.id)) await registry.create(pane.viewport, pane.id);
  chromeWindow.on("closed", () => { flowDraft.cancel(); void registry?.destroy(); chromeWindow = undefined; registry = undefined; });
  publishState();
}

app.commandLine.appendSwitch("disable-background-timer-throttling");
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.whenReady().then(createChrome).catch((error) => { console.error(error); app.quit(); });
