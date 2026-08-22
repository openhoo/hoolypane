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
import { loadWorkspace, saveWorkspace, sweepStaleTemporaries } from "./persistence/workspace-store.js";
import { captureOverview, capturePane } from "./screenshots/screenshot-service.js";

let chromeWindow: BrowserWindow | undefined;
let registry: PaneRegistry | undefined;
let workspacePath = "";
let nextActionId = 1;
const coordinator = new InteractionCoordinator();
const flowDraft = new FlowDraft();
const pendingReplay = new Map<string, { resolve: (result: ReplayResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let chromeStarting = false;
let commandQueue = Promise.resolve();
let flushBarrier = false;
let lastError: string | null = null;
let workspacePersistable = true;
const deferredActions: Array<{ paneId: string; observed: unknown }> = [];
let drainingDeferredActions = false;

function trustedChrome(event: IpcMainEvent): boolean {
  return chromeWindow !== undefined && event.sender === chromeWindow.webContents && event.senderFrame === chromeWindow.webContents.mainFrame;
}

function sourcePane(event: IpcMainEvent): string | undefined {
  if (event.senderFrame !== event.sender.mainFrame) return undefined;
  return registry?.paneIdForWebContents(event.sender);
}

function publishState(): void {
  if (chromeWindow && registry) chromeWindow.webContents.send(IPC_CHANNELS.state, { ...registry.getState(), recording: flowDraft.isActive, lastError });
}

function report(paneId: string, message: string): void {
  console.error(`[hoolypane] ${paneId === "" ? "main" : `pane ${paneId}`}: ${message}`);
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
  const paneRegistry = registry;
  const chrome = chromeWindow;
  if (!paneRegistry || !chrome) return;
  flushBarrier = true;
  try {
    for (const record of paneRegistry.panes.values()) record.view.webContents.send(IPC_CHANNELS.flush);
    const { promise: flushed, resolve: flushSettled } = Promise.withResolvers<void>();
    setTimeout(flushSettled, 325);
    await flushed;
  } finally {
    flushBarrier = false;
    drainDeferredActions();
  }
  try {
    const stopped = flowDraft.stop();
    if (stopped.kind === "blocked") throw new Error(`Flow cannot be exported:\n${stopped.reasons.join("\n")}`);
    if (stopped.kind === "empty") {
      flowDraft.commit();
      return;
    }
    const directPath = testFlowSavePath();
    if (directPath === "") {
      flowDraft.commit();
      return;
    }
    if (directPath) {
      await fs.writeFile(directPath, stopped.source, "utf8");
      flowDraft.commit();
      return;
    }
    const selection = await dialog.showSaveDialog(chrome, {
      title: "Save Hoolypane flow",
      defaultPath: "hoolypane-flow.ts",
      filters: [{ name: "TypeScript", extensions: ["ts"] }],
    });
    if (selection.canceled || !selection.filePath) {
      flowDraft.commit();
      return;
    }
    await fs.writeFile(selection.filePath, stopped.source, { encoding: "utf8", flag: "wx" }).catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await fs.writeFile(selection.filePath!, stopped.source, "utf8");
    });
    flowDraft.commit();
  } finally {
    publishState();
  }
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
      flushBarrier = true;
      try {
        for (const record of registry.panes.values()) record.view.webContents.send(IPC_CHANNELS.flush);
        await registry.navigate(command.url);
      } finally {
        flushBarrier = false;
        drainDeferredActions();
      }
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
  if (workspacePersistable) {
    lastError = null;
    publishState();
    await saveWorkspace(workspacePath, registry.getState());
  } else {
    publishState();
  }
}

function replayKey(paneId: string, actionId: number, phase: ReplayResult["phase"]): string {
  return `${paneId}:${actionId}:${phase}`;
}

function waitForReplayResult(paneId: string, actionId: number, phase: ReplayResult["phase"]): Promise<ReplayResult> {
  return new Promise((resolve, reject) => {
    const key = replayKey(paneId, actionId, phase);
    const timer = setTimeout(() => {
      pendingReplay.delete(key);
      reject(new Error(`pane ${paneId} timed out during ${phase}`));
    }, 5_000);
    pendingReplay.set(key, { resolve, reject, timer });
  });
}

function requestReplay(paneId: string, request: ReplayRequest): Promise<ReplayResult> {
  const record = registry?.getPane(paneId);
  if (!record) return Promise.reject(new Error(`pane closed: ${paneId}`));
  const result = waitForReplayResult(paneId, request.actionId, request.phase);
  record.view.webContents.send(IPC_CHANNELS.replay, request);
  return result;
}

async function applyCdp(paneId: string, envelope: ActionEnvelope, resolved: ReplayResult): Promise<void> {
  const record = registry?.getPane(paneId);
  const box = resolved.box;
  if (!record || !box) throw new Error("target did not provide an element box");
  if (record.documentGeneration !== envelope.documentGeneration) throw new Error(`stale document generation ${envelope.documentGeneration}, current ${record.documentGeneration}`);
  const cdp = record.view.webContents.debugger;
  const scale = registry?.getInputScale(paneId) ?? 1;
  const x = (box.x + box.width / 2) * scale;
  const y = (box.y + box.height / 2) * scale;
  const click = async (): Promise<void> => {
    const confirmation = waitForReplayResult(paneId, envelope.actionId, "confirm");
    record.view.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 });
    record.view.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 });
    const result = await confirmation;
    if (!result.ok) throw new Error(result.reason ?? "replayed click was not confirmed");
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
  // A navigation may start between resolve and native input delivery; refuse to count the action as applied then.
  if (record.documentGeneration !== envelope.documentGeneration) throw new Error(`stale document generation ${envelope.documentGeneration}, current ${record.documentGeneration}`);
}

async function replayEnvelope(paneId: string, envelope: ActionEnvelope): Promise<void> {
  await applyTestReplayDelay();
  if (envelope.action.kind === "navigate") {
    await registry?.getPane(paneId)?.view.webContents.loadURL(normalizeUrl(envelope.action.url));
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
  if (flushBarrier) {
    // Buffer instead of dropping: actions observed during a navigate/stop flush are processed once the barrier lifts.
    deferredActions.push({ paneId: sourcePaneId, observed });
    return;
  }
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
    if (outcome.ok) {
      registry.clearOutOfSync(outcome.paneId);
      flowDraft.unblock(envelope.actionId);
    } else if (!registry.getPane(outcome.paneId)) continue;
    else {
      const reason = outcome.reason ?? "unknown replay failure";
      registry.markOutOfSync(outcome.paneId, envelope.actionId, envelope.action.kind, reason);
      flowDraft.block(envelope.actionId, `${outcome.paneId}: ${reason}`);
      report(outcome.paneId, reason);
    }
  }
  publishState();
}

function drainDeferredActions(): void {
  if (drainingDeferredActions || flushBarrier || deferredActions.length === 0) return;
  drainingDeferredActions = true;
  void (async () => {
    try {
      while (!flushBarrier && registry && deferredActions.length > 0) {
        const next = deferredActions.shift();
        if (!next) break;
        try {
          await acceptSourceAction(next.paneId, next.observed);
        } catch (error) {
          report(next.paneId, error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      drainingDeferredActions = false;
    }
  })();
}

async function createChrome(): Promise<void> {
  workspacePath = join(app.getPath("userData"), "workspace.json");
  await sweepStaleTemporaries(workspacePath);
  const loaded = await loadWorkspace(workspacePath);
  workspacePersistable = loaded.persistable;
  if (!loaded.persistable) lastError = "workspace.json was written by a newer Hoolypane version or is unreadable — automatic saving is disabled for this session";
  let workspace = {
    ...loaded.state,
    panes: loaded.state.panes.map((pane) => ({ ...pane, canGoBack: false, canGoForward: false, loading: false, failure: null, outOfSync: null })),
  };
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
  chromeWindow.on("closed", () => { flowDraft.cancel(); void registry?.destroy(); chromeWindow = undefined; registry = undefined; });
  registry = new PaneRegistry({ workspace, onChange: publishState, onFailure: (failure) => report(failure.paneId, failure.message) });
  registry.attachWindow(chromeWindow);
  chromeWindow.once("ready-to-show", () => chromeWindow?.show());
  await chromeWindow.loadFile(join(dirname(fileURLToPath(import.meta.url)), "renderer/index.html"));
  for (const pane of workspace.panes) {
    if (chromeWindow.isDestroyed()) return;
    if (!registry.panes.has(pane.id)) await registry.create(pane.viewport, pane.id);
  }
  if (chromeWindow.isDestroyed()) return;
  publishState();
}

app.commandLine.appendSwitch("disable-background-timer-throttling");
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (chromeWindow) {
      chromeWindow.restore();
      chromeWindow.focus();
    } else void launchChrome().catch((error: unknown) => { console.error(error); });
  });
  void app.whenReady().then(launchChrome).catch((error: unknown) => { console.error(error); app.quit(); });
}
app.on("activate", () => { void launchChrome().catch((error: unknown) => { console.error(error); }); });

async function launchChrome(): Promise<void> {
  if (chromeWindow !== undefined || chromeStarting) return;
  chromeStarting = true;
  try {
    await createChrome();
  } finally {
    chromeStarting = false;
  }
}

  ipcMain.on(IPC_CHANNELS.bounds, (event, value: unknown) => {
    if (!trustedChrome(event)) return;
    try { registry?.applyBounds(BoundsSnapshotSchema.parse(value)); } catch (error) { report("", error instanceof Error ? error.message : String(error)); }
  });
  ipcMain.on(IPC_CHANNELS.command, (event, value: unknown) => {
    if (!trustedChrome(event)) return;
    try {
      commandQueue = commandQueue
        .then(() => handleCommand(ChromeCommandSchema.parse(value)))
        .catch((error: unknown) => {
          lastError = error instanceof Error ? error.message : String(error);
          report("", lastError);
          publishState();
        });
    } catch (error) { report("", error instanceof Error ? error.message : String(error)); }
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
