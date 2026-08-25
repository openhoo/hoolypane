import { fileURLToPath } from "node:url";
import { BrowserWindow, session, type Session, type WebContents, WebContentsView } from "electron";
import { IPC_CHANNELS, PaneGenerationSchema, ViewportSpecSchema, type Action, type BoundsSnapshot, type ColorSchemeMode, type OverlayKey, type ThrottlingMode, type ViewportSpec } from "@hoolypane/contracts";
import { displayScale, validateBoundsSnapshot, type Bounds } from "./layout.js";
import { isAllowedProtocol, normalizeUrl } from "./url.js";
import { addPane, closePane, defaultWorkspace, removePane, rotatePane, uniquePaneId, updatePane, type PaneState, type WorkspaceState } from "./workspace.js";

type PaneFailure = { paneId: string; message: string };
type PaneRecord = { id: string; view: WebContentsView; lastBounds?: Bounds; debuggerAttached: boolean; networkEmulationReady: boolean; initialized: boolean; documentGeneration: number; overlayCssKeys: Partial<Record<OverlayKey, string>>; creationEpoch: number; settingsChain?: Promise<void> };

// Monotonic per-record identity: lets replay bookkeeping tell a recreated pane apart from its predecessor with the same id.
let nextCreationEpoch = 1;

// Strips userinfo and query/hash from URLs embedded in failure messages so credentials never leak into UI state or logs.
function redactUrlForMessage(value: string): string {
  if (!value) return value;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<unparsable>";
  }
}

export class PaneRegistry {
  readonly panes = new Map<string, PaneRecord>();
  private workspace: WorkspaceState;
  private readonly paneSession: Session;
  private readonly onChange: ((workspace: WorkspaceState) => void) | undefined;
  private readonly onFailure: ((failure: PaneFailure) => void) | undefined;
  private window: BrowserWindow | undefined;
  // Registry-wide document generation: bumped on every main-frame navigation of ANY pane and
  // mirrored into every record. A single counter keeps generations comparable across panes, so
  // a pane-local navigation can never make cross-pane sync reject as "stale" forever (the old
  // per-pane counters drifted apart permanently), while any navigation between observation and
  // replay still invalidates the envelope.
  private documentEpoch = 0;

  constructor(options: { onChange?: (workspace: WorkspaceState) => void; onFailure?: (failure: PaneFailure) => void; workspace?: WorkspaceState } = {}) {
    this.workspace = options.workspace ?? defaultWorkspace();
    this.onChange = options.onChange;
    this.onFailure = options.onFailure;
    this.paneSession = session.fromPartition("persist:hoolypane");
    this.installSessionSecurity();
  }

  attachWindow(window: BrowserWindow): void { this.window = window; }
  getState(): WorkspaceState { return this.workspace; }
  getPane(paneId: string): PaneRecord | undefined { return this.panes.get(paneId); }
  getPaneState(paneId: string): PaneState | undefined { return this.workspace.panes.find((pane) => pane.id === paneId); }
  getInputScale(paneId: string): number {
    const pane = this.getPaneState(paneId);
    const bounds = this.panes.get(paneId)?.lastBounds;
    if (!pane) return 1;
    const width = bounds && bounds.width > 0 ? bounds.width : 1;
    const height = bounds && bounds.height > 0 ? bounds.height : 1;
    // Electron applies the emulation scale before routing Input-domain pointer coordinates into a WebContentsView.
    return displayScale(width, height, pane.viewport.width, pane.viewport.height);
  }
  paneIdForWebContents(contents: WebContents): string | undefined {
    for (const [paneId, record] of this.panes) if (record.view.webContents === contents) return paneId;
    return undefined;
  }
  markOutOfSync(paneId: string, actionId: number, actionKind: Action["kind"], reason: string): void {
    this.setPane(paneId, { outOfSync: { actionId, actionKind, reason } });
  }
  /** Clears the out-of-sync mark unless a newer failure superseded it: any action success at or
   * after the marked one proves the pane recovered, while an older action's success must not hide
   * a newer failure (marks carry monotonically increasing action ids). */
  clearOutOfSync(paneId: string, actionId: number): void {
    const mark = this.getPaneState(paneId)?.outOfSync;
    if (!mark || mark.actionId > actionId) return;
    this.setPane(paneId, { outOfSync: null });
  }
  epochOf(paneId: string): number | undefined { return this.panes.get(paneId)?.creationEpoch; }
  async create(viewport: ViewportSpec, paneId?: string): Promise<string> {
    const valid = ViewportSpecSchema.parse(viewport);
    const id = paneId ?? uniquePaneId(new Set([...this.workspace.order, ...this.panes.keys()]), valid.id);
    if (this.panes.has(id)) throw new Error(`pane already exists: ${id}`);
    if (!this.window) throw new Error("pane registry has no window");
    const view = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: "persist:hoolypane", preload: this.panePreloadPath() } });
    view.webContents.setBackgroundThrottling(false);
    const preexistingEntry = this.workspace.panes.find((pane) => pane.id === id);
    // Track whether this call introduced the workspace entry: rollback must stay symmetric and
    // never delete a pane that existed before the failed create (e.g. a restored saved pane).
    const record: PaneRecord = { id, view, debuggerAttached: false, networkEmulationReady: false, initialized: false, documentGeneration: this.documentEpoch, overlayCssKeys: {}, creationEpoch: nextCreationEpoch++ };
    this.panes.set(id, record);
    this.window.contentView.addChildView(view);
    this.workspace = preexistingEntry ? this.workspace : addPane(this.workspace, valid, this.workspace.sharedUrl, id);
    this.emitChange();
    try {
      await view.webContents.loadURL("about:blank");
      if (!this.isLive(record)) return id;
      // about:blank completed: the view is initialized and safe for CDP emulation. Until this
      // flag flips, applyBoundsEntry defers configureViewport to this gated call (SIGSEGV guard).
      record.initialized = true;
      await this.configureViewport(record);
      if (!this.isLive(record)) return id;
      await this.applyPaneSettings(record);
      // The chrome renderer measures pane cards once when they mount; if this record was
      // created after that measurement, the snapshot skipped it and no renderer churn will
      // re-emit. Replay this record's measured entry so late-created panes receive geometry.
      this.applyBoundsIfCached(record);
      this.bindPane(record);
      const pane = this.getPaneState(id);
      // Content-load failures are reported per pane via did-fail-load; creation must not fail on network problems.
      await Promise.allSettled([view.webContents.loadURL(this.restoreTarget(pane?.url ?? this.workspace.sharedUrl))]);
    } catch (error) {
      // A destroyed window means the registry is going away anyway; a rollback would fight destroy().
      if (this.window && !this.window.isDestroyed()) await this.rollbackCreate(record, !preexistingEntry);
      throw error;
    }
    return id;
  }

  async close(paneId: string): Promise<void> {
    const record = this.panes.get(paneId);
    if (!record) {
      // A failed startup recreate intentionally keeps its workspace entry (rollback preserves
      // pre-existing ones); the record-less card must stay closable: drop just the entry.
      const next = closePane(this.workspace, paneId);
      if (next !== this.workspace) { this.workspace = next; this.emitChange(); }
      // Same cache hygiene as the record path: a reused id must not resurrect stale geometry.
      this.pruneCachedBounds(paneId);
      return;
    }
    if (this.workspace.panes.length === 1) return;
    this.panes.delete(paneId);
    this.workspace = closePane(this.workspace, paneId);
    this.pruneCachedBounds(paneId);
    await this.destroyRecord(record);
    this.emitChange();
  }

  /** Drops the closed pane's entry from the cached snapshot so a reused pane id cannot resurrect stale geometry. */
  private pruneCachedBounds(paneId: string): void {
    const snapshot = this.lastBoundsSnapshot;
    if (!snapshot || !snapshot.panes.some((entry) => entry.paneId === paneId)) return;
    this.lastBoundsSnapshot = { ...snapshot, panes: snapshot.panes.filter((entry) => entry.paneId !== paneId) };
  }

  rename(paneId: string, name: string): void {
    if (!name.trim()) throw new Error("pane name must not be empty");
    this.workspace = updatePane(this.workspace, paneId, (pane) => ({ ...pane, name: name.trim() }));
    this.emitChange();
  }
  rotate(paneId: string): void { this.workspace = rotatePane(this.workspace, paneId); const record = this.panes.get(paneId); if (record) void this.configureViewport(record); this.emitChange(); }
  focus(paneId: string | null): void { if (paneId !== null && !this.workspace.order.includes(paneId)) throw new Error(`unknown pane: ${paneId}`); this.workspace = { ...this.workspace, focusedPaneId: paneId }; this.emitChange(); }
  setLayout(layout: WorkspaceState["layout"]): void { this.workspace = { ...this.workspace, layout }; this.emitChange(); }

  setPanePosition(paneId: string, x: number, y: number): void {
    if (!this.workspace.order.includes(paneId)) throw new Error(`unknown pane: ${paneId}`);
    this.workspace = { ...this.workspace, positions: { ...this.workspace.positions, [paneId]: { x, y } } };
    this.emitChange();
  }
  setSync(enabled: boolean): void { this.workspace = { ...this.workspace, syncEnabled: enabled }; this.emitChange(); }
  setColorScheme(value: ColorSchemeMode): void { this.workspace = { ...this.workspace, emulation: { ...this.workspace.emulation, colorScheme: value } }; this.applyEmulation(); }
  setReducedMotion(enabled: boolean): void { this.workspace = { ...this.workspace, emulation: { ...this.workspace.emulation, reducedMotion: enabled } }; this.applyEmulation(); }
  setThrottling(mode: ThrottlingMode): void { this.workspace = { ...this.workspace, emulation: { ...this.workspace.emulation, throttling: mode } }; this.applyEmulation(); }
  setOverlay(key: OverlayKey, enabled: boolean): void {
    this.workspace = { ...this.workspace, emulation: { ...this.workspace.emulation, overlays: { ...this.workspace.emulation.overlays, [key]: enabled } } };
    this.applyEmulation();
  }

  /** Fans the current global emulation state out to every live pane; never throws. */
  private applyEmulation(): void {
    this.emitChange();
    for (const record of this.panes.values()) void this.applyPaneSettings(record);
  }

  /** Applies global emulation media/network state plus overlays to one pane via its CDP debugger; failures are logged only.
   * Invocations serialize per record through an in-flight promise chain: overlapping calls race shared CSS keys and debugger state otherwise. */
  applyPaneSettings(record: PaneRecord): Promise<void> {
    const task = (record.settingsChain ?? Promise.resolve()).then(() => this.writeEmulationSettings(record));
    record.settingsChain = task.then(() => undefined, () => undefined);
    return task;
  }

  private async writeEmulationSettings(record: PaneRecord): Promise<void> {
    if (!this.isLive(record)) return;
    const contents = record.view.webContents;
    const emulation = this.workspace.emulation;
    try {
      if (!record.debuggerAttached) { contents.debugger.attach("1.3"); record.debuggerAttached = true; }
      // The features list is replaced wholesale on every send: inactive settings are omitted so
      // Chromium resets them ("auto"/false) and no stale override can survive a toggle-off.
      const features: Array<{ name: string; value: string }> = [];
      if (emulation.colorScheme !== "auto") features.push({ name: "prefers-color-scheme", value: emulation.colorScheme });
      if (emulation.reducedMotion) features.push({ name: "prefers-reduced-motion", value: "reduce" });
      await contents.debugger.sendCommand("Emulation.setEmulatedMedia", { features });
      if (!record.networkEmulationReady) { await contents.debugger.sendCommand("Network.enable"); record.networkEmulationReady = true; }
      await contents.debugger.sendCommand("Network.emulateNetworkConditions", networkConditions(emulation.throttling));
    } catch (error) {
      if (this.isLive(record)) console.error(`[hoolypane] pane ${record.id}: emulation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.applyOverlays(record);
  }

  private async applyOverlays(record: PaneRecord): Promise<void> {
    if (!this.isLive(record)) return;
    const contents = record.view.webContents;
    const overlays = this.workspace.emulation.overlays;
    try {
      // insertCSS keys do not survive cross-document navigation: drop every cached key first,
      // then inject exactly the currently active overlays.
      const staleKeys = record.overlayCssKeys;
      record.overlayCssKeys = {};
      for (const key of OVERLAY_KEYS) {
        const cssKey = staleKeys[key];
        if (cssKey !== undefined) await contents.removeInsertedCSS(cssKey).catch(() => undefined);
        if (overlays[key]) record.overlayCssKeys[key] = await contents.insertCSS(OVERLAY_STYLES[key]);
      }
    } catch (error) {
      if (this.isLive(record)) console.error(`[hoolypane] pane ${record.id}: overlay injection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async navigate(url: string): Promise<void> {
    const target = normalizeUrl(url);
    this.workspace = { ...this.workspace, sharedUrl: target };
    const tasks = this.workspace.order.map(async (paneId) => {
      const record = this.panes.get(paneId);
      if (!record) return;
      await record.view.webContents.loadURL(target);
    });
    await Promise.allSettled(tasks);
    this.emitChange();
  }
  back(paneId: string): void { this.panes.get(paneId)?.view.webContents.goBack(); }
  forward(paneId: string): void { this.panes.get(paneId)?.view.webContents.goForward(); }
  reload(paneId: string): void { this.panes.get(paneId)?.view.webContents.reload(); }

  private lastBoundsSnapshot: BoundsSnapshot | undefined;

  applyBounds(snapshot: BoundsSnapshot): void {
    validateBoundsSnapshot(snapshot, this.workspace.order);
    this.lastBoundsSnapshot = snapshot;
    for (const item of snapshot.panes) {
      const record = this.panes.get(item.paneId);
      if (!record || record.lastBounds && sameBounds(record.lastBounds, item.bounds)) continue;
      this.applyBoundsEntry(record, item, snapshot.windowWidth, snapshot.windowHeight);
    }
  }

  /** Re-applies the latest renderer-measured entry for a record created after that measurement. */
  private applyBoundsIfCached(record: PaneRecord): void {
    const snapshot = this.lastBoundsSnapshot;
    const item = snapshot?.panes.find((entry) => entry.paneId === record.id);
    if (snapshot && item) this.applyBoundsEntry(record, item, snapshot.windowWidth, snapshot.windowHeight);
  }

  private applyBoundsEntry(record: PaneRecord, item: BoundsSnapshot["panes"][number], windowWidth: number, windowHeight: number): void {
    if (item.bounds.x + item.bounds.width > windowWidth || item.bounds.y + item.bounds.height > windowHeight) return;
    const visible = item.bounds.width > 0 && item.bounds.height > 0;
    record.view.setBounds(visible ? item.bounds : { x: 0, y: 0, width: 1, height: 1 });
    record.lastBounds = item.bounds;
    void this.configureViewport(record);
  }

  async destroy(): Promise<void> {
    const records = [...this.panes.values()];
    this.panes.clear();
    // Every cached bounds entry now refers to a closed pane id: drop the snapshot wholesale.
    this.lastBoundsSnapshot = undefined;
    await Promise.all(records.map((record) => this.destroyRecord(record)));
  }

  private bindPane(record: PaneRecord): void {
    const contents = record.view.webContents;
    contents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return;
      // One shared counter for every pane: all records advance together, so envelopes stamped by
      // any pane stay comparable against any target. Broadcast immediately so every preload's
      // local mirror (and its suppression sweep) observes the same value before later replays.
      this.documentEpoch += 1;
      const generation = PaneGenerationSchema.parse({ documentGeneration: this.documentEpoch });
      for (const other of this.panes.values()) {
        other.documentGeneration = this.documentEpoch;
        other.view.webContents.send(IPC_CHANNELS.paneGeneration, generation);
      }
    });
    contents.on("did-finish-load", () => {
      // Resend on finish-load: a just-attached or reloaded preload must learn the current epoch.
      contents.send(IPC_CHANNELS.paneGeneration, PaneGenerationSchema.parse({ documentGeneration: record.documentGeneration }));
      // insertCSS keys die with the finished document: re-inject active overlays for the new one.
      void this.applyPaneSettings(record);
    });
    contents.on("did-start-loading", () => this.setPane(record.id, { loading: true }));
    contents.on("did-stop-loading", () => this.setPane(record.id, { loading: false, canGoBack: contents.canGoBack(), canGoForward: contents.canGoForward() }));
    contents.on("did-navigate", (_event, url) => {
      if (!isAllowedProtocol(url)) return; // ignore chrome-error://chromewebdata/, about: and other non-http(s) commits
      // A committed http(s) main-frame navigation proves recovery: drop any stale failure banner.
      this.setPane(record.id, { url: normalizeUrl(url), canGoBack: contents.canGoBack(), canGoForward: contents.canGoForward(), failure: null });
    });
    contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => { if (isMainFrame && errorCode !== -3) this.reportFailure(record.id, `${errorDescription} (${errorCode}) at ${redactUrlForMessage(validatedURL)}`); });
    contents.on("render-process-gone", (_event, details) => this.reportFailure(record.id, `render process gone: ${details.reason}`));
    contents.on("will-navigate", (event, url) => { if (!isAllowedProtocol(url)) event.preventDefault(); });
    contents.on("will-redirect", (event, url) => { if (!isAllowedProtocol(url)) event.preventDefault(); });
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedProtocol(url)) void contents.loadURL(url).catch(() => {});
      return { action: "deny" };
    });
  }

  private async configureViewport(record: PaneRecord): Promise<void> {
    // create() gates CDP emulation behind the about:blank load; bounds snapshots arriving
    // during that window defer to create()'s own post-load configureViewport call.
    if (!record.initialized) return;
    const pane = this.getPaneState(record.id);
    if (!pane) return;
    const contents = record.view.webContents;
    try {
      if (!record.debuggerAttached) { contents.debugger.attach("1.3"); record.debuggerAttached = true; }
      const bounds = record.lastBounds;
      const availableWidth = bounds && bounds.width > 0 ? bounds.width : 1;
      const availableHeight = bounds && bounds.height > 0 ? bounds.height : 1;
      const scale = displayScale(availableWidth, availableHeight, pane.viewport.width, pane.viewport.height);
      await contents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: pane.viewport.width, height: pane.viewport.height, deviceScaleFactor: pane.viewport.deviceScaleFactor, mobile: pane.viewport.isMobile, scale });
      await contents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: pane.viewport.hasTouch, configuration: pane.viewport.hasTouch ? "mobile" : "desktop" });
    } catch (error) { if (!this.isLive(record)) return; this.reportFailure(record.id, `viewport emulation failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private installSessionSecurity(): void {
    this.paneSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    this.paneSession.setPermissionCheckHandler(() => false);
    this.paneSession.on("will-download", (_event, item) => item.cancel());
  }

  private async destroyRecord(record: PaneRecord): Promise<void> {
    const contents = record.view.webContents;
    try { if (record.debuggerAttached && contents.debugger.isAttached()) contents.debugger.detach(); } catch { /* renderer may already be gone */ }
    try { this.window?.contentView.removeChildView(record.view); } catch { /* window may be closing */ }
    if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
  }

  private setPane(paneId: string, patch: Partial<PaneState>): void { this.workspace = updatePane(this.workspace, paneId, (pane) => ({ ...pane, ...patch })); this.emitChange(); }
  private reportFailure(paneId: string, message: string): void { this.setPane(paneId, { failure: message, loading: false }); this.onFailure?.({ paneId, message }); }
  private emitChange(): void { this.onChange?.(this.workspace); }

  private isLive(record: PaneRecord): boolean { return this.panes.get(record.id) === record && !record.view.webContents.isDestroyed(); }

  private restoreTarget(value: string): string {
    try { return normalizeUrl(value); } catch { /* corrupt persisted URL: fall through to sharedUrl */ }
    try { return normalizeUrl(this.workspace.sharedUrl); } catch { return defaultWorkspace().sharedUrl; }
  }

  private async rollbackCreate(record: PaneRecord, addedWorkspaceEntry: boolean): Promise<void> {
    this.panes.delete(record.id);
    // Symmetric rollback: only remove the workspace entry when this create introduced it.
    if (addedWorkspaceEntry) this.workspace = removePane(this.workspace, record.id);
    await this.destroyRecord(record).catch(() => undefined);
    this.emitChange();
  }
  private panePreloadPath(): string { return fileURLToPath(new URL("../preload/pane.js", import.meta.url)); }
}
function sameBounds(left: Bounds, right: Bounds): boolean { return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height; }

const OVERLAY_STYLES: Record<OverlayKey, string> = {
  outlines: "*{outline:1px solid rgba(99,102,241,.4)!important}",
  disableImages: "img,picture,video,source,[style*=\"background-image\"]{filter:grayscale(1) opacity(.25)!important}",
  showRoles: "[role]{position:relative}[role]::before{content:\"[\"attr(role)\"]\";position:absolute;background:#6366f1;color:#fff;font:10px monospace;padding:1px 3px;z-index:2147483647}",
};
const OVERLAY_KEYS = Object.keys(OVERLAY_STYLES) as OverlayKey[];

function networkConditions(mode: ThrottlingMode): { offline: boolean; latency: number; downloadThroughput: number; uploadThroughput: number } {
  if (mode === "offline") return { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 };
  if (mode === "slow3g") return { offline: false, latency: 300, downloadThroughput: 50_000, uploadThroughput: 20_000 };
  return { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
}
