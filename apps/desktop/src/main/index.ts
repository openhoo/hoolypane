import { app, BrowserWindow, ipcMain, type IpcMainEvent } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BoundsSnapshotSchema,
  ChromeCommandSchema,
  FILL_DEBOUNCE_MS,
  IPC_CHANNELS,
  PaneObservedActionSchema,
  RECORDABLE_PRESS_KEYS,
  RecordFailureSchema,
  ReplayResultSchema,
  RUNTIME_PANE_DEFAULTS,
  errorMessage,
  staleGenerationMessage,
  type ActionEnvelope,
  type ChromeCommand,
  type ReplayRequest,
  type ReplayResult,
} from "@hoolypane/contracts";
import { FlowDraft } from "./interactions/flow-draft.js";
import { InteractionCoordinator } from "./interactions/interaction-coordinator.js";
import { PaneRegistry } from "./panes/pane-registry.js";
import { normalizeUrl } from "./panes/url.js";
import { flushWorkspaceSaves, loadWorkspace, saveWorkspace, sweepStaleTemporaries, writeFileAtomic } from "./persistence/workspace-store.js";
import { report } from "./report.js";
import { captureOverview, capturePane, saveViaDialog, testEnvFilePath } from "./screenshots/screenshot-service.js";

let chromeWindow: BrowserWindow | undefined;
let registry: PaneRegistry | undefined;
let quittingRegistry: PaneRegistry | undefined;
let workspacePath = "";
let nextActionId = 1;
const coordinator = new InteractionCoordinator();
const flowDraft = new FlowDraft();
const pendingReplay = new Map<string, { resolve: (result: ReplayResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; epoch: number }>();
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

/** Record-stop flush settle: must exceed the pane preload's FILL_DEBOUNCE_MS so a straggler trusted
 *  input re-arming the debounce right after the flush send still lands inside this barrier. */
const STOP_FLUSH_SETTLE_MS = FILL_DEBOUNCE_MS + 25;

function trustedChrome(event: IpcMainEvent): boolean {
  return chromeWindow !== undefined && event.sender === chromeWindow.webContents && event.senderFrame === chromeWindow.webContents.mainFrame;
}

function sourcePane(event: IpcMainEvent): string | undefined {
  if (event.senderFrame !== event.sender.mainFrame) return undefined;
  return registry?.paneIdForWebContents(event.sender);
}

function publishState(): void {
  if (!chromeWindow || !registry || chromeWindow.isDestroyed() || chromeWindow.webContents.isDestroyed()) return;
  chromeWindow.webContents.send(IPC_CHANNELS.state, { ...registry.getState(), recording: flowDraft.isActive, lastError });
}

function testFlowSavePath(): string | undefined {
  if (process.env.HOOLYPANE_TEST_MODE !== "1") return undefined;
  if (process.env.HOOLYPANE_TEST_FLOW_SAVE_CANCEL === "1") return "";
  return testEnvFilePath("HOOLYPANE_TEST_FLOW_PATH", ".ts", "TypeScript");
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


/**
 * Flush-barrier protocol shared by record-stop and navigate: every pane is told to flush its
 * pending observations, actions observed while the barrier is up are buffered instead of applied
 * (see acceptSourceAction), and the buffer drains once the barrier lifts.
 */
async function runWithFlushBarrier<T>(paneRegistry: PaneRegistry, settle: () => Promise<T>): Promise<T> {
  flushBarrier = true;
  try {
    for (const record of paneRegistry.panes.values()) record.view.webContents.send(IPC_CHANNELS.flush);
    return await settle();
  } finally {
    flushBarrier = false;
    drainDeferredActions();
  }
}
async function stopAndSaveFlow(): Promise<StopFlowOutcome> {
  const paneRegistry = registry;
  const chrome = chromeWindow;
  if (!paneRegistry || !chrome) return { kind: "handled" };
  await runWithFlushBarrier(paneRegistry, async () => {
    const { promise: flushed, resolve: flushSettled } = Promise.withResolvers<void>();
    setTimeout(flushSettled, STOP_FLUSH_SETTLE_MS);
    await flushed;
  });
  // The drain spawned by the barrier lift runs asynchronously: let it finish so every buffered action is
  // reflected in the draft BEFORE stop() computes the export outcome.
  if (activeDrain) await activeDrain;
  // Every completed stop commits exactly once; a thrown writeFileAtomic skips the commit so a failed
  // save leaves the recording retryable.
  const finish = (outcome: StopFlowOutcome): StopFlowOutcome => { commitFlowDraft(); return outcome; };
  try {
    const stopped = flowDraft.stop();
    // A trailing replay failure is a discardable outcome, not a wedge: abandon the save
    // here so the draft can never stay active past record-stop; the caller surfaces the
    // reasons as a user-visible lastError instead of this throwing past cleanup.
    if (stopped.kind === "blocked") return finish({ kind: "blocked", reasons: stopped.reasons });
    if (stopped.kind === "empty") return finish({ kind: "handled" });
    const directPath = testFlowSavePath();
    if (directPath === "") return finish({ kind: "handled" });
    if (directPath) {
      await writeFileAtomic(directPath, stopped.source);
      return finish({ kind: "handled" });
    }
    await saveViaDialog(chrome, stopped.source, {
      title: "Save Hoolypane flow",
      defaultPath: "hoolypane-flow.ts",
      filterName: "TypeScript",
      extension: "ts",
    });
    return finish({ kind: "handled" });
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
    case "rename": paneRegistry.rename(command.paneId, command.name); break;
    case "rotate": paneRegistry.rotate(command.paneId); break;
    case "focus": paneRegistry.focus(command.paneId); break;
    case "navigate": await runWithFlushBarrier(paneRegistry, () => paneRegistry.navigate(command.url)); break;
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
      if (firstPane) flowDraft.start(paneRegistry.getState().sharedUrl, firstPane, nextActionId++);
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

function waitForReplayResult(paneId: string, actionId: number, phase: ReplayResult["phase"], epoch: number): Promise<ReplayResult> {
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

// Compile-typed against RECORDABLE_PRESS_KEYS: a key added there without replay params here fails
// typecheck instead of silently replaying a bare rawKeyDown.
const PRESS_KEY_EVENTS: Record<string, Pick<KeyEventParams, "code" | "windowsVirtualKeyCode" | "text">> = {
  Enter: { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
  Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
} satisfies Record<(typeof RECORDABLE_PRESS_KEYS)[number], Pick<KeyEventParams, "code" | "windowsVirtualKeyCode" | "text">>;

// Select-all preceding every fill: Chromium keys the editing command off the Windows virtual key
// code plus the Ctrl (2) / Cmd (4 on darwin) modifier, never the key name.
const SELECT_ALL_KEY = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: process.platform === "darwin" ? 4 : 2 };

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
  if (record.documentGeneration !== envelope.documentGeneration) throw new Error(staleGenerationMessage(envelope.documentGeneration, record.documentGeneration));
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
    await cdp.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", ...SELECT_ALL_KEY });
    await cdp.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...SELECT_ALL_KEY });
    await cdp.sendCommand("Input.insertText", { text: action.value });
  } else if (action.kind === "press") {
    await cdp.sendCommand("Input.dispatchKeyEvent", pressKeyDownEvent(action.key));
    await cdp.sendCommand("Input.dispatchKeyEvent", pressKeyUpEvent(action.key));
  }
  // A navigation may start between resolve and native input delivery; refuse to count the action as applied then.
  if (record.documentGeneration !== envelope.documentGeneration) throw new Error(staleGenerationMessage(envelope.documentGeneration, record.documentGeneration));
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
  const sourceRecord = paneRegistry.getPane(sourcePaneId);
  // A reloaded/re-attached preload restarts at generation 0 and only learns the current epoch
  // at did-finish-load; an observation stamped with anything but the source record's live
  // generation comes from that gap (or an already-navigated document). Drop it before envelope
  // construction: strict equality downstream would fail it on every target, mass-flagging panes
  // out of sync and recording an envelope no pane can ever replay.
  if (sourceRecord && sourceRecord.documentGeneration !== source.documentGeneration) return;
  // Fields are already-valid by construction (source.action passed PaneObservedActionSchema.parse);
  // FlowDraft.append's internal parse stays the single validation point.
  const envelope: ActionEnvelope = {
    actionId: nextActionId++,
    documentGeneration: source.documentGeneration,
    sourcePaneId,
    action: source.action,
  };
  flowDraft.append(envelope, draftGeneration);
  if (!paneRegistry.getState().syncEnabled) return;
  const targets = paneRegistry.getState().order.filter((paneId) => paneId !== sourcePaneId);
  // Stamp each target's pane instance when its replay actually starts (not at dispatch time:
  // coordinator queues can hold a task across a close+re-add of the same pane id) so outcomes
  // are attributed to the exact surface they ran against.
  const startEpochs = new Map<string, number | undefined>();
  const outcomes = await coordinator.dispatch(envelope, targets, async (targetPaneId, env) => {
    startEpochs.set(targetPaneId, paneRegistry.getPane(targetPaneId)?.creationEpoch);
    await replayEnvelope(targetPaneId, env);
  });
  for (const outcome of outcomes) {
    // An outcome describes one specific pane instance. If that instance is gone — closed and
    // re-added under the same id with a new creationEpoch, or cancelled before its replay
    // started so no stamp exists — the current pane never received this replay: neither blame
    // it as out of sync, nor clear its state on the dead instance's success.
    const record = paneRegistry.getPane(outcome.paneId);
    if (!record || record.creationEpoch !== startEpochs.get(outcome.paneId)) continue;
    if (outcome.ok) {
      // Scope the clear to the succeeded action: a success for one action must not hide a
      // different unresolved failure on the same pane.
      paneRegistry.clearOutOfSync(outcome.paneId, envelope.actionId);
      flowDraft.unblock(envelope.actionId, outcome.paneId);
    } else {
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
        const next = deferredActions.shift()!;
        try {
          await acceptSourceAction(next.paneId, next.observed);
        } catch (error) {
          report(next.paneId, errorMessage(error));
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
    panes: loaded.state.panes.map((pane) => ({ ...pane, ...RUNTIME_PANE_DEFAULTS })),
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
  chromeWindow.on("closed", () => { commitFlowDraft(); quittingRegistry = registry; void registry?.destroy(); chromeWindow = undefined; registry = undefined; });
  registry = new PaneRegistry({ workspace, onChange: publishState, onFailure: (failure) => report(failure.paneId, failure.message) });
  quittingRegistry = undefined;
  registry.attachWindow(chromeWindow);
  chromeWindow.once("ready-to-show", () => chromeWindow?.show());
  // Pin the singletons for the awaited restore below: the 'closed' handler may fire mid-await
  // and clear the module-levels, so every later touch goes through these locals.
  const shell = chromeWindow;
  const paneRegistry = registry;
  try {
    await shell.loadFile(rendererPath);
    for (const pane of workspace.panes) {
      if (shell.isDestroyed()) return;
      if (!paneRegistry.panes.has(pane.id)) await paneRegistry.create(pane.viewport, pane.id);
    }
  } catch (error) {
    // A failed load or pane restore leaves an invisible window behind: show:false plus a
    // ready-to-show that never fired means there is no error surface inside it, and keeping it
    // alive wedges every relaunch behind the launchChrome guard. Destroying routes cleanup
    // through the 'closed' handler above, which resets the singletons for a clean retry.
    shell.destroy();
    throw error;
  }
  if (shell.isDestroyed()) return;
  publishState();
}

app.commandLine.appendSwitch("disable-background-timer-throttling");
// Surface relaunch failures instead of swallowing them: prefer the renderer error surface,
// fall back to quitting when no window exists to show anything in.
const handleLaunchFailure = (error: unknown): void => {
  const message = errorMessage(error);
  report("", message);
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
    // Bound the drain: a stuck command must not hold the app hostage at shutdown. Commands
    // arriving mid-drain reassign commandQueue, so keep awaiting fresh tails until the chain
    // stops changing (or the shared deadline expires) before the final state write below.
    const deadline = Date.now() + QUIT_FLUSH_DEADLINE_MS;
    let outcome: "drained" | "timeout" = "drained";
    let tail = commandQueue;
    while (true) {
      outcome = await Promise.race([
        tail.then(() => "drained" as const, () => "drained" as const),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), Math.max(deadline - Date.now(), 0))),
      ]);
      if (outcome === "timeout" || commandQueue === tail) break;
      tail = commandQueue;
    }
    if (outcome === "timeout") report("", `command drain exceeded the ${QUIT_FLUSH_DEADLINE_MS}ms quit deadline; proceeding with shutdown`);
    const activeRegistry = registry ?? quittingRegistry;
    try {
      // Provider form: state is read when the write executes, covering any mutation that
      // landed between the last drained snapshot and this write.
      if (workspacePersistable && activeRegistry && workspacePath) await saveWorkspace(workspacePath, () => activeRegistry.getState());
    } catch (error) {
      // Never block quit: a native dialog here wedges headless/Xvfb sessions forever, so
      // surface the failure through the log only and proceed with shutdown.
      report("", `failed to save the workspace during quit: ${errorMessage(error)}`);
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
  try { registry?.applyBounds(BoundsSnapshotSchema.parse(value)); } catch (error) { report("", errorMessage(error)); }
});
ipcMain.on(IPC_CHANNELS.command, (event, value: unknown) => {
  if (!trustedChrome(event)) return;
  commandQueue = commandQueue
    .then(() => handleCommand(ChromeCommandSchema.parse(value)))
    .catch((error: unknown) => {
      lastError = errorMessage(error);
      report("", lastError);
      publishState();
    });
});
ipcMain.on(IPC_CHANNELS.stateRequest, (event) => { if (!trustedChrome(event)) return; publishState(); });
ipcMain.on(IPC_CHANNELS.paneAction, (event, value: unknown) => {
  const paneId = sourcePane(event);
  if (!paneId) return;
  void acceptSourceAction(paneId, value).catch((error: unknown) => report(paneId, errorMessage(error)));
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
  } catch (error) { report(paneId, errorMessage(error)); }
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
    if (registry?.getPane(paneId)?.creationEpoch !== pending.epoch) return;
    pending.resolve(parsed);
  } catch (error) { report(paneId, errorMessage(error)); }
});
