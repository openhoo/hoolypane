import { app, BrowserWindow, dialog, ipcMain, type IpcMainEvent } from "electron";
import { promises as fs } from "node:fs";
import { dirname, extname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ActionEnvelopeSchema,
  BoundsSnapshotSchema,
  ChromeCommandSchema,
  IPC_CHANNELS,
  PaneObservedActionSchema,
  RecordFailureSchema,
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
import { flushWorkspaceSaves, loadWorkspace, saveWorkspace, sweepStaleTemporaries } from "./persistence/workspace-store.js";
import { captureOverview, capturePane } from "./screenshots/screenshot-service.js";

let chromeWindow: BrowserWindow | undefined;
let registry: PaneRegistry | undefined;
let quittingRegistry: PaneRegistry | undefined;
let workspacePath = "";
let nextActionId = 1;
const coordinator = new InteractionCoordinator();
const flowDraft = new FlowDraft();
const pendingReplay = new Map<string, { resolve: (result: ReplayResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; epoch?: number | undefined }>();
let chromeStarting = false;
let commandQueue = Promise.resolve();
let flushBarrier = false;
let lastError: string | null = null;
let workspacePersistable = true;
const deferredActions: Array<{ paneId: string; observed: unknown }> = [];
let drainingDeferredActions = false;
// Promise of the running deferred-action drain; stopAndSaveFlow awaits it before reading the draft.
let activeDrain: Promise<void> | null = null;

/** Deadline for the before-quit command drain so a stuck command can never hold the app hostage. */
const QUIT_FLUSH_DEADLINE_MS = 10_000;

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

/** Ends the recording session and drops any still-buffered pre-stop actions so they cannot leak into the next one. */
function commitFlowDraft(): void {
  deferredActions.length = 0;
  flowDraft.commit();
}

/** Record-stop outcome: "blocked" reports unresolved replay failures after the draft was discarded; "handled" covers persisted, empty, and abandoned saves. */
type StopFlowOutcome = { kind: "blocked"; reasons: string[] } | { kind: "handled" };

async function stopAndSaveFlow(): Promise<StopFlowOutcome> {
  const paneRegistry = registry;
  const chrome = chromeWindow;
  if (!paneRegistry || !chrome) return { kind: "handled" };
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
  // The drain spawned above runs asynchronously: let it finish so every buffered action is
  // reflected in the draft BEFORE stop() computes the export outcome.
  if (activeDrain) await activeDrain;
  try {
    const stopped = flowDraft.stop();
    // A trailing replay failure is a discardable outcome, not a wedge: abandon the save
    // here so the draft can never stay active past record-stop; the caller surfaces the
    // reasons as a user-visible lastError instead of this throwing past cleanup.
    if (stopped.kind === "blocked") {
      commitFlowDraft();
      return { kind: "blocked", reasons: stopped.reasons };
    }
    if (stopped.kind === "empty") {
      commitFlowDraft();
      return { kind: "handled" };
    }
    const directPath = testFlowSavePath();
    if (directPath === "") {
      commitFlowDraft();
      return { kind: "handled" };
    }
    if (directPath) {
      await fs.writeFile(directPath, stopped.source, "utf8");
      commitFlowDraft();
      return { kind: "handled" };
    }
    const selection = await dialog.showSaveDialog(chrome, {
      title: "Save Hoolypane flow",
      defaultPath: "hoolypane-flow.ts",
      filters: [{ name: "TypeScript", extensions: ["ts"] }],
    });
    if (selection.canceled || !selection.filePath) {
      commitFlowDraft();
      return { kind: "handled" };
    }
    await fs.writeFile(selection.filePath, stopped.source, { encoding: "utf8", flag: "wx" }).catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await fs.writeFile(selection.filePath!, stopped.source, "utf8");
    });
    commitFlowDraft();
    return { kind: "handled" };
  } finally {
    publishState();
  }
}

async function handleCommand(command: ChromeCommand): Promise<void> {
  // Pin the registry for the whole body: the singleton may be swapped or cleared mid-command.
  const paneRegistry = registry;
  if (!paneRegistry) return;
  switch (command.kind) {
    case "create": await paneRegistry.create(command.viewport); break;
    case "close": {
      // Once the pane is gone its replay failures can never recover via a later recorded action
      // on it, so drop them: stop() must not discard every future save over a deleted pane.
      coordinator.cancelPane(command.paneId);
      await paneRegistry.close(command.paneId);
      flowDraft.discardPane(command.paneId);
      break;
    }
    case "duplicate": await paneRegistry.duplicate(command.paneId); break;
    case "rename": paneRegistry.rename(command.paneId, command.name); break;
    case "reorder": paneRegistry.reorder(command.paneId, command.index); break;
    case "resize": paneRegistry.resize(command.paneId, command.width, command.height); break;
    case "rotate": paneRegistry.rotate(command.paneId); break;
    case "focus": paneRegistry.focus(command.paneId); break;
    case "navigate": {
      flushBarrier = true;
      try {
        for (const record of paneRegistry.panes.values()) record.view.webContents.send(IPC_CHANNELS.flush);
        await paneRegistry.navigate(command.url);
      } finally {
        flushBarrier = false;
        drainDeferredActions();
      }
      break;
    }
    case "back": paneRegistry.back(command.paneId); break;
    case "forward": paneRegistry.forward(command.paneId); break;
    case "reload": paneRegistry.reload(command.paneId); break;
    case "set-layout": paneRegistry.setLayout(command.layout); break;
    case "move-pane": paneRegistry.setPanePosition(command.paneId, command.x, command.y); break;
    case "set-sync": paneRegistry.setSync(command.enabled); break;
    case "set-color-scheme": paneRegistry.setColorScheme(command.value); break;
    case "set-reduced-motion": paneRegistry.setReducedMotion(command.enabled); break;
    case "set-throttling": paneRegistry.setThrottling(command.mode); break;
    case "set-overlay": paneRegistry.setOverlay(command.key, command.enabled); break;
    case "record-start": {
      // A recording is already running: surface the refusal instead of silently restarting.
      if (flowDraft.isActive) throw new Error("a flow recording is already active");
      // Drop stale buffered actions so a previous session's leftovers never seed the new recording.
      deferredActions.length = 0;
      const firstPane = paneRegistry.getState().order[0];
      if (firstPane) flowDraft.start(paneRegistry.getState().sharedUrl, firstPane, nextActionId++, Date.now());
      break;
    }
    case "record-stop": {
      const stopped = await stopAndSaveFlow();
      if (stopped.kind !== "blocked") break;
      // Early return, not break: the success tail below resets lastError on every completed
      // command and would instantly erase the discard signal published here. Skipping the
      // tail also mirrors the old throw path, which never reached the workspace save either.
      const message = `flow recording discarded without saving:\n${stopped.reasons.join("\n")}`;
      lastError = message;
      report("", message);
      publishState();
      return;
    }
    case "capture-pane": if (chromeWindow) await capturePane(chromeWindow, paneRegistry, command.paneId); break;
    case "capture-overview": if (chromeWindow) await captureOverview(chromeWindow, paneRegistry); break;
  }
  // Re-read singletons after the awaited body: the window may have closed mid-command.
  if (!chromeWindow || registry !== paneRegistry) return;
  if (workspacePersistable) {
    lastError = null;
    publishState();
    await saveWorkspace(workspacePath, paneRegistry.getState());
  } else {
    publishState();
  }
}

function replayKey(paneId: string, actionId: number, phase: ReplayResult["phase"]): string {
  return `${paneId}:${actionId}:${phase}`;
}

function waitForReplayResult(paneId: string, actionId: number, phase: ReplayResult["phase"], epoch?: number): Promise<ReplayResult> {
  const key = replayKey(paneId, actionId, phase);
  const { promise, resolve, reject } = Promise.withResolvers<ReplayResult>();
  const timer = setTimeout(() => {
    pendingReplay.delete(key);
    reject(new Error(`pane ${paneId} timed out during ${phase}`));
  }, 5_000);
  // Stamp the pane's creation epoch so a late result from a superseded surface is recognizable.
  pendingReplay.set(key, { resolve, reject, timer, epoch });
  return promise;
}

function requestReplay(paneId: string, request: ReplayRequest): Promise<ReplayResult> {
  const record = registry?.getPane(paneId);
  if (!record) return Promise.reject(new Error(`pane closed: ${paneId}`));
  const result = waitForReplayResult(paneId, request.actionId, request.phase, record.creationEpoch);
  record.view.webContents.send(IPC_CHANNELS.replay, request);
  return result;
}

/** Parameters for a replayed native key event. Chromium matches editing commands and default key
 *  behaviors (select-all, implicit form submit, focus traversal) on the Windows virtual key code
 *  and the char text, never on the key name: omitting them makes replays silently diverge from
 *  Playwright's own press() of the same recorded flow. */
type KeyEventParams = { type: "rawKeyDown" | "keyDown" | "keyUp"; key: string; code?: string | undefined; windowsVirtualKeyCode?: number | undefined; text?: string | undefined; unmodifiedText?: string | undefined };

// The only keys the pane preload records (preload/pane.ts restricts press to this set).
const PRESS_KEY_EVENTS: Record<string, Pick<KeyEventParams, "code" | "windowsVirtualKeyCode" | "text">> = {
  Enter: { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
  Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
};

function pressKeyDownEvent(key: string): KeyEventParams {
  const spec = PRESS_KEY_EVENTS[key];
  if (!spec) return { type: "rawKeyDown", key };
  // With char text Chromium synthesizes the matching char event, exactly like Playwright's
  // raw-keyboard dispatch for Enter (keyDown + "\r"); without it, rawKeyDown + virtual code.
  return spec.text === undefined
    ? { type: "rawKeyDown", key, code: spec.code, windowsVirtualKeyCode: spec.windowsVirtualKeyCode }
    : { type: "keyDown", key, code: spec.code, windowsVirtualKeyCode: spec.windowsVirtualKeyCode, text: spec.text, unmodifiedText: spec.text };
}

function pressKeyUpEvent(key: string): KeyEventParams {
  const spec = PRESS_KEY_EVENTS[key];
  return spec
    ? { type: "keyUp", key, code: spec.code, windowsVirtualKeyCode: spec.windowsVirtualKeyCode }
    : { type: "keyUp", key };
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
    const confirmation = waitForReplayResult(paneId, envelope.actionId, "confirm", record.creationEpoch);
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
    await cdp.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: process.platform === "darwin" ? 4 : 2 });
    await cdp.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: process.platform === "darwin" ? 4 : 2 });
    await cdp.sendCommand("Input.insertText", { text: action.value });
  } else if (action.kind === "press") {
    await cdp.sendCommand("Input.dispatchKeyEvent", pressKeyDownEvent(action.key));
    await cdp.sendCommand("Input.dispatchKeyEvent", pressKeyUpEvent(action.key));
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
  // Envelope generations come from the registry-wide documentEpoch: any pane's main-frame
  // navigation bumps it once and broadcasts the new value to every pane, so all live mirrors
  // share one counter and strict cross-pane equality holds by construction. Forward the
  // envelope's generation unchanged; staleness then means exactly "this target's document
  // changed under the replay" (enforced below between resolve and input delivery, and by the
  // target preload's generation-keyed echo guard). Never translate the value to the target's
  // current epoch: rewriting it would defeat that echo suppression and let stale pending
  // mirrors land as phantom user inputs mid-navigation.
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
  const paneRegistry = registry;
  if (!paneRegistry) return;
  if (flushBarrier) {
    // Buffer instead of dropping: actions observed during a navigate/stop flush are processed once the barrier lifts.
    deferredActions.push({ paneId: sourcePaneId, observed });
    return;
  }
  // Capture the draft session before any await: an outliving drain must not pollute a newer recording.
  const draftGeneration = flowDraft.sessionGeneration;
  const source = PaneObservedActionSchema.parse(observed);
  const envelope = ActionEnvelopeSchema.parse({
    actionId: nextActionId++,
    documentGeneration: source.documentGeneration,
    sourcePaneId,
    action: source.action,
    recordedAtUnixMs: Date.now(),
  });
  flowDraft.append(envelope, draftGeneration);
  if (!paneRegistry.getState().syncEnabled) return;
  const targets = paneRegistry.getState().order.filter((paneId) => paneId !== sourcePaneId);
  const outcomes = await coordinator.dispatch(envelope, targets, replayEnvelope);
  for (const outcome of outcomes) {
    if (outcome.ok) {
      // Scope the clear to the succeeded action: a success for one action must not hide a
      // different unresolved failure on the same pane.
      paneRegistry.clearOutOfSync(outcome.paneId, envelope.actionId);
      flowDraft.unblock(envelope.actionId, outcome.paneId);
    } else if (!paneRegistry.getPane(outcome.paneId)) continue;
    else {
      const reason = outcome.reason ?? "unknown replay failure";
      paneRegistry.markOutOfSync(outcome.paneId, envelope.actionId, envelope.action.kind, reason);
      flowDraft.block(envelope.actionId, outcome.paneId, reason);
    }
  }
  publishState();
}

function drainDeferredActions(): void {
  if (drainingDeferredActions || flushBarrier || deferredActions.length === 0) return;
  drainingDeferredActions = true;
  activeDrain = (async () => {
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
    activeDrain = null;
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
  // The renderer document path is needed twice: as the load target and as the only URL the
  // navigation guards below may ever see this window load.
  const rendererPath = join(dirname(fileURLToPath(import.meta.url)), "renderer/index.html");
  const rendererUrl = pathToFileURL(rendererPath).href;
  chromeWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 720,
    minHeight: 600,
    show: false,
    webPreferences: { preload: fileURLToPath(new URL("../preload/chrome.js", import.meta.url)), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  // This window carries the privileged hoolypaneChrome bridge, and Electron re-exposes preload
  // APIs into whatever document the window loads next. A link or file dragged onto the toolbar
  // would otherwise hand the bridge (full workspace state plus pane-steering commands) to that
  // document. Renderer-initiated navigations are therefore denied except reloading our own
  // bundled renderer; only main-process loadFile() populates this window. Popups and permission
  // requests from a hostile document are refused the same way. Panes are unaffected: their
  // content lives in separate WebContentsViews with their own bindPane() guards.
  chromeWindow.webContents.on("will-navigate", (event, url) => {
    if (url === rendererUrl) return;
    event.preventDefault();
  });
  chromeWindow.webContents.on("will-redirect", (event) => event.preventDefault());
  chromeWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const shellContents = chromeWindow.webContents;
  // Scoped to the shell webContents: every other surface keeps its session's existing behavior.
  shellContents.session.setPermissionRequestHandler((requesting, _permission, callback) => callback(requesting !== shellContents));
  shellContents.session.setPermissionCheckHandler((requesting) => requesting !== shellContents);
  chromeWindow.on("closed", () => { flowDraft.cancel(); quittingRegistry = registry; void registry?.destroy(); chromeWindow = undefined; registry = undefined; });
  registry = new PaneRegistry({ workspace, onChange: publishState, onFailure: (failure) => report(failure.paneId, failure.message) });
  quittingRegistry = undefined;
  registry.attachWindow(chromeWindow);
  chromeWindow.once("ready-to-show", () => chromeWindow?.show());
  try {
    await chromeWindow.loadFile(rendererPath);
    for (const pane of workspace.panes) {
      if (chromeWindow.isDestroyed()) return;
      if (!registry.panes.has(pane.id)) await registry.create(pane.viewport, pane.id);
    }
  } catch (error) {
    // A failed load or pane restore leaves an invisible window behind: show:false plus a
    // ready-to-show that never fired means there is no error surface inside it, and keeping it
    // alive wedges every relaunch behind the launchChrome guard. Destroying routes cleanup
    // through the 'closed' handler above, which resets the singletons for a clean retry.
    chromeWindow.destroy();
    throw error;
  }
  if (chromeWindow.isDestroyed()) return;
  publishState();
}

app.commandLine.appendSwitch("disable-background-timer-throttling");
  // Surface relaunch failures instead of swallowing them: prefer the renderer error surface,
  // fall back to quitting when no window exists to show anything in.
  const handleLaunchFailure = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    if (chromeWindow && !chromeWindow.isDestroyed()) {
      lastError = `failed to (re)open the Hoolypane window: ${message}`;
      publishState();
    } else {
      app.quit();
    }
  };
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (chromeWindow) {
      chromeWindow.restore();
      chromeWindow.focus();
    } else void launchChrome().catch(handleLaunchFailure);
  });
  void app.whenReady().then(launchChrome).catch(handleLaunchFailure);
}
app.on("activate", () => { void launchChrome().catch(handleLaunchFailure); });

// Flush-on-quit: a workspace mutation racing app shutdown must still reach disk. Every quit
// request is held (preventDefault) until queued commands plus every in-flight save tail have
// drained, then quit is re-issued once with the hold lifted. This includes a second quit signal
// arriving mid-drain (another Cmd+Q, window-all-closed, session end): letting it through would
// tear down the app ahead of the final save.
let quitFlushStarted = false;
let quitFlushComplete = false;
app.on("before-quit", (event) => {
  if (quitFlushComplete) return;
  event.preventDefault();
  if (quitFlushStarted) return;
  quitFlushStarted = true;
  void (async () => {
    // Bound the drain: a stuck command must not hold the app hostage at shutdown.
    const outcome = await Promise.race([
      commandQueue.then(() => "drained" as const, () => "drained" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), QUIT_FLUSH_DEADLINE_MS)),
    ]);
    if (outcome === "timeout") report("", `command drain exceeded the ${QUIT_FLUSH_DEADLINE_MS}ms quit deadline; proceeding with shutdown`);
    const activeRegistry = registry ?? quittingRegistry;
    try {
      // Enqueue as a tail with a provider: state is read when the write executes, so mutations
      // landing during the drain above are still included.
      if (workspacePersistable && activeRegistry && workspacePath) await saveWorkspace(workspacePath, () => activeRegistry.getState());
    } catch (error) {
      // Never block quit: a native dialog here wedges headless/Xvfb sessions forever, so
      // surface the failure through the log only and proceed with shutdown.
      report("", `failed to save the workspace during quit: ${error instanceof Error ? error.message : String(error)}`);
    }
    try { await flushWorkspaceSaves(); } catch { /* save tails never reject */ }
    quitFlushComplete = true;
    app.quit();
  })();
});
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
  ipcMain.on(IPC_CHANNELS.stateRequest, (event) => { if (!trustedChrome(event)) return; if (chromeWindow && registry) publishState(); });
  ipcMain.on(IPC_CHANNELS.paneAction, (event, value: unknown) => {
    const paneId = sourcePane(event);
    if (!paneId) return;
    void acceptSourceAction(paneId, value).catch((error: unknown) => report(paneId, error instanceof Error ? error.message : String(error)));
  });
  ipcMain.on(IPC_CHANNELS.recordFailure, (event, value: unknown) => {
    const paneId = sourcePane(event);
    if (!paneId) return;
    try {
      const failure = RecordFailureSchema.parse(value);
      // Only meaningful mid-recording: a failed recorded action must surface to the user.
      if (!flowDraft.isActive) return;
      lastError = `pane ${paneId}: recording failed: ${failure.reason}`;
      report(paneId, `recording failed: ${failure.reason}`);
      publishState();
    } catch (error) { report(paneId, error instanceof Error ? error.message : String(error)); }
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
      // A result authored by a superseded surface (pane closed and recreated with the same id)
      // belongs to no live waiter: drop it and let the requester's timeout clean up.
      if (pending.epoch !== undefined && registry?.epochOf(paneId) !== pending.epoch) return;
      pending.resolve({ ...parsed, paneId });
    } catch (error) { report(paneId, error instanceof Error ? error.message : String(error)); }
  });
