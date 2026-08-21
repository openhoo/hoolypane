import { fileURLToPath } from "node:url";
import { BrowserWindow, session, type Session, type WebContents, WebContentsView } from "electron";
import { BoundsSnapshotSchema, IPC_CHANNELS, PaneGenerationSchema, ViewportSpecSchema, type ViewportSpec } from "@hoolypane/contracts";
import { validateBoundsSnapshot, type Bounds } from "./layout.js";
import { normalizeUrl } from "./url.js";
import { addPane, closePane, defaultWorkspace, duplicatePane, reorderPane, rotatePane, updatePane, type PaneState, type WorkspaceState } from "./workspace.js";

type PaneFailure = { paneId: string; message: string };
type PaneRecord = { id: string; view: WebContentsView; lastBounds?: Bounds; debuggerAttached: boolean; documentGeneration: number };

export class PaneRegistry {
  readonly panes = new Map<string, PaneRecord>();
  private workspace: WorkspaceState;
  private readonly paneSession: Session;
  private readonly onChange: ((workspace: WorkspaceState) => void) | undefined;
  private readonly onFailure: ((failure: PaneFailure) => void) | undefined;
  private window: BrowserWindow | undefined;

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
    return Math.min(1, width / pane.viewport.width, height / pane.viewport.height);
  }
  paneIdForWebContents(contents: WebContents): string | undefined {
    for (const [paneId, record] of this.panes) if (record.view.webContents === contents) return paneId;
    return undefined;
  }
  markOutOfSync(paneId: string, actionId: number, actionKind: string, reason: string): void {
    this.setPane(paneId, { outOfSync: { actionId, actionKind, reason } });
  }
  clearOutOfSync(paneId: string): void {
    this.setPane(paneId, { outOfSync: null });
  }

  async create(viewport: ViewportSpec, paneId?: string): Promise<string> {
    const valid = ViewportSpecSchema.parse(viewport);
    const id = paneId ?? this.nextPaneId(valid.id);
    if (this.panes.has(id)) throw new Error(`pane already exists: ${id}`);
    if (!this.window) throw new Error("pane registry has no window");
    const view = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: "persist:hoolypane", preload: this.panePreloadPath() } });
    view.webContents.setBackgroundThrottling(false);
    const record: PaneRecord = { id, view, debuggerAttached: false, documentGeneration: 0 };
    this.panes.set(id, record);
    this.window.contentView.addChildView(view);
    this.workspace = this.workspace.order.includes(id) ? this.workspace : addPane(this.workspace, { ...valid, id }, this.workspace.sharedUrl);
    this.emitChange();
    await view.webContents.loadURL("about:blank");
    await this.configureViewport(record);
    this.bindPane(record);
    const pane = this.getPaneState(id);
    await view.webContents.loadURL(pane?.url ?? this.workspace.sharedUrl);
    return id;
  }

  async close(paneId: string): Promise<void> {
    const record = this.panes.get(paneId);
    if (!record || this.workspace.panes.length === 1) return;
    this.panes.delete(paneId);
    this.workspace = closePane(this.workspace, paneId);
    await this.destroyRecord(record);
    this.emitChange();
  }

  async duplicate(paneId: string): Promise<string> {
    const source = this.getPaneState(paneId);
    if (!source) throw new Error(`unknown pane: ${paneId}`);
    const next = duplicatePane(this.workspace, paneId);
    const created = next.order.find((id) => !this.workspace.order.includes(id));
    if (!created) throw new Error("unable to duplicate pane");
    this.workspace = next;
    await this.create(next.panes.find((pane) => pane.id === created)!.viewport, created);
    return created;
  }

  rename(paneId: string, name: string): void {
    if (!name.trim()) throw new Error("pane name must not be empty");
    this.workspace = updatePane(this.workspace, paneId, (pane) => ({ ...pane, name: name.trim() }));
    this.emitChange();
  }
  reorder(paneId: string, index: number): void { this.workspace = reorderPane(this.workspace, paneId, index); this.emitChange(); }
  resize(paneId: string, width: number, height: number): void {
    this.workspace = updatePane(this.workspace, paneId, (pane) => ({ ...pane, viewport: ViewportSpecSchema.parse({ ...pane.viewport, width, height }) }));
    const record = this.panes.get(paneId);
    if (record) void this.configureViewport(record);
    this.emitChange();
  }
  rotate(paneId: string): void { this.workspace = rotatePane(this.workspace, paneId); const record = this.panes.get(paneId); if (record) void this.configureViewport(record); this.emitChange(); }
  focus(paneId: string | null): void { if (paneId !== null && !this.panes.has(paneId)) throw new Error(`unknown pane: ${paneId}`); this.workspace = { ...this.workspace, focusedPaneId: paneId }; this.emitChange(); }
  setLayout(layout: WorkspaceState["layout"]): void { this.workspace = { ...this.workspace, layout }; this.emitChange(); }
  setSync(enabled: boolean): void { this.workspace = { ...this.workspace, syncEnabled: enabled }; this.emitChange(); }

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

  applyBounds(snapshot: unknown): void {
    const parsed = BoundsSnapshotSchema.parse(snapshot);
    validateBoundsSnapshot(parsed, this.workspace.order);
    for (const item of parsed.panes) {
      const record = this.panes.get(item.paneId);
      if (!record || record.lastBounds && sameBounds(record.lastBounds, item.bounds)) continue;
      const visible = item.bounds.width > 0 && item.bounds.height > 0;
      record.view.setBounds(visible ? item.bounds : { x: 0, y: 0, width: 1, height: 1 });
      record.lastBounds = item.bounds;
      void this.configureViewport(record);
    }
  }

  async destroy(): Promise<void> {
    const records = [...this.panes.values()];
    this.panes.clear();
    await Promise.all(records.map((record) => this.destroyRecord(record)));
  }

  private bindPane(record: PaneRecord): void {
    const contents = record.view.webContents;
    contents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return;
      record.documentGeneration += 1;
    });
    contents.on("did-finish-load", () => {
      contents.send(IPC_CHANNELS.paneGeneration, PaneGenerationSchema.parse({ documentGeneration: record.documentGeneration }));
    });
    contents.on("did-start-loading", () => this.setPane(record.id, { loading: true, failure: null }));
    contents.on("did-stop-loading", () => this.setPane(record.id, { loading: false, canGoBack: contents.canGoBack(), canGoForward: contents.canGoForward() }));
    contents.on("did-navigate", (_event, url) => this.setPane(record.id, { url: normalizeUrl(url), canGoBack: contents.canGoBack(), canGoForward: contents.canGoForward() }));
    contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => { if (isMainFrame && errorCode !== -3) this.reportFailure(record.id, `${errorDescription} (${errorCode}) at ${validatedURL}`); });
    contents.on("render-process-gone", (_event, details) => this.reportFailure(record.id, `render process gone: ${details.reason}`));
    contents.on("will-navigate", (event, url) => { if (!isAllowedProtocol(url)) event.preventDefault(); });
    contents.on("will-redirect", (event, url) => { if (!isAllowedProtocol(url)) event.preventDefault(); });
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedProtocol(url)) void contents.loadURL(url);
      return { action: "deny" };
    });
  }

  private async configureViewport(record: PaneRecord): Promise<void> {
    const pane = this.getPaneState(record.id);
    if (!pane) return;
    const contents = record.view.webContents;
    try {
      if (!record.debuggerAttached) { contents.debugger.attach("1.3"); record.debuggerAttached = true; }
      const bounds = record.lastBounds;
      const availableWidth = bounds && bounds.width > 0 ? bounds.width : 1;
      const availableHeight = bounds && bounds.height > 0 ? bounds.height : 1;
      const scale = Math.min(1, availableWidth / pane.viewport.width, availableHeight / pane.viewport.height);
      await contents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: pane.viewport.width, height: pane.viewport.height, deviceScaleFactor: pane.viewport.deviceScaleFactor, mobile: pane.viewport.isMobile, scale });
      await contents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: pane.viewport.hasTouch, configuration: pane.viewport.hasTouch ? "mobile" : "desktop" });
    } catch (error) { this.reportFailure(record.id, `viewport emulation failed: ${error instanceof Error ? error.message : String(error)}`); }
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
  private nextPaneId(seed: string): string { let id = seed; let index = 2; while (this.panes.has(id)) id = `${seed}-${index++}`; return id; }
  private panePreloadPath(): string { return fileURLToPath(new URL("../preload/pane.js", import.meta.url)); }
}
function sameBounds(left: Bounds, right: Bounds): boolean { return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height; }
function isAllowedProtocol(url: string): boolean { try { const protocol = new URL(url).protocol; return protocol === "http:" || protocol === "https:"; } catch { return false; } }
