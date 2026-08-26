/**
 * DEV MOCK — standalone browser preview bridge.
 *
 * Synthesizes the `window.hoolypaneChrome` preload API so the renderer can run
 * in a plain browser (vite dev server) without Electron. It is only installed
 * when the real preload bridge is absent AND import.meta.env.DEV is true, so
 * production builds never ship or activate it. State transitions are validated
 * against ChromeStateSchema / BoundsSnapshotSchema just like the real main
 * process, keeping the IPC contract honest during UI development.
 */
import { BoundsSnapshotSchema, ChromeCommandSchema, ChromeStateSchema, errorMessage } from "@hoolypane/contracts";
import type { BoundsSnapshot, ChromeCommand, ChromeState, PaneState } from "@hoolypane/contracts";
import { initialChromeState } from "./state.js";
// Imported verbatim from the main process so the mock can never drift from the real
// navigation-normalization pipeline (slashless special schemes, userinfo stripping).
import { normalizeUrl } from "../../main/panes/url.js";
import { addPane, closePane, rotatePane } from "../../main/panes/workspace.js";

let mockState: ChromeState = initialChromeState();
const listeners = new Set<(value: unknown) => void>();
let loadingTimer: number | undefined;
const pendingSettleIds = new Set<string>();

function patch(partial: Partial<ChromeState>): void {
  const parsed = ChromeStateSchema.safeParse({ ...mockState, ...partial });
  if (!parsed.success) {
    console.error("[hoolypane dev-mock] rejected state transition", parsed.error.message);
    return;
  }
  mockState = parsed.data;
  for (const listener of listeners) listener(mockState);
}

function patchPane(paneId: string, changes: Partial<PaneState>): void {
  patch({ panes: mockState.panes.map((pane) => (pane.id === paneId ? { ...pane, ...changes } : pane)) });
}
// Mirrors main's PaneRegistry.patchEmulation seam: one owner for the nested emulation spread
// instead of per-case hand-synced copies of the EmulationSettings field layout.
function patchEmulation(patchPartial: Partial<ChromeState["emulation"]>): void {
  patch({ emulation: { ...mockState.emulation, ...patchPartial } });
}

// Overlapping settles ACCUMULATE targets: clear-and-reschedule per call would drop panes not
// named by the newest caller, wedging them in loading:true forever.
function settleLoading(paneIds: readonly string[]): void {
  for (const id of paneIds) pendingSettleIds.add(id);
  if (loadingTimer !== undefined) return;
  loadingTimer = window.setTimeout(() => {
    loadingTimer = undefined;
    const settled = new Set(pendingSettleIds);
    pendingSettleIds.clear();
    patch({ panes: mockState.panes.map((pane) => (settled.has(pane.id) ? { ...pane, loading: false } : pane)) });
  }, 600);
}

function apply(command: ChromeCommand): void {
  let refused = false;
  switch (command.kind) {
    case "navigate": {
      let url: string;
      try {
        url = normalizeUrl(command.url);
      } catch (error) {
        // Mirror main's command .catch: rejected navigations surface via lastError, not silence.
        patch({ lastError: errorMessage(error) });
        refused = true;
        break;
      }
      patch({
        sharedUrl: url,
        panes: mockState.panes.map((pane) => ({ ...pane, url, loading: true, canGoBack: true, canGoForward: false, failure: null })),
      });
      settleLoading(mockState.order);
      break;
    }
    case "back":
      patchPane(command.paneId, { canGoBack: false, canGoForward: true });
      break;
    case "forward":
      patchPane(command.paneId, { canGoBack: true, canGoForward: false });
      break;
    case "reload":
      patchPane(command.paneId, { loading: true });
      settleLoading([command.paneId]);
      break;
    case "create": {
      const next = addPane(mockState, command.viewport);
      patch(next);
      break;
    }
    case "close": {
      // Same reference for last-pane/unknown-id no-ops, so the guard skips pointless republishes.
      const next = closePane(mockState, command.paneId);
      if (next !== mockState) patch(next);
      break;
    }
    case "rename": {
      // Mirror main's PaneRegistry.rename: whitespace-only names are rejected via lastError.
      const name = command.name.trim();
      if (!name) {
        patch({ lastError: "pane name must not be empty" });
        refused = true;
        break;
      }
      patchPane(command.paneId, { name });
      break;
    }
    case "move-pane":
      // Mirror main's PaneRegistry.setPanePosition: unknown ids are refused via lastError
      // instead of accumulating orphaned position entries production state can never contain.
      if (!mockState.order.includes(command.paneId)) {
        patch({ lastError: `unknown pane: ${command.paneId}` });
        refused = true;
        break;
      }
      patch({ positions: { ...mockState.positions, [command.paneId]: { x: command.x, y: command.y } } });
      break;
    case "rotate": {
      const next = rotatePane(mockState, command.paneId);
      if (next !== mockState) patch(next);
      break;
    }
    case "focus":
      // Mirror main's PaneRegistry.focus guard so unknown ids surface as a refusal here
      // instead of dying later inside ChromeStateSchema.safeParse.
      if (command.paneId !== null && !mockState.order.includes(command.paneId)) {
        patch({ lastError: `unknown pane: ${command.paneId}` });
        refused = true;
        break;
      }
      patch({ focusedPaneId: command.paneId });
      break;
    case "set-layout":
      patch({ layout: command.layout });
      break;
    case "set-sync":
      patch({ syncEnabled: command.enabled });
      break;
    case "set-color-scheme":
      patchEmulation({ colorScheme: command.value });
      break;
    case "set-reduced-motion":
      patchEmulation({ reducedMotion: command.enabled });
      break;
    case "set-throttling":
      patchEmulation({ throttling: command.mode });
      break;
    case "set-overlay":
      patchEmulation({ overlays: { ...mockState.emulation.overlays, [command.key]: command.enabled } });
      break;
    case "capture-pane":
    case "capture-overview":
      // Screenshots require the native WebContentsView; no-op success in the mock.
      break;
    case "record-start":
      // Mirror main's handleCommand refusal: a running recording must not silently restart.
      if (mockState.recording) {
        patch({ lastError: "a flow recording is already active" });
        refused = true;
        break;
      }
      patch({ recording: true });
      break;
    case "record-stop":
      patch({ recording: false });
      break;
  }
  // Mirror main's success tail (handleCommand): every completed command resets lastError
  // before republishing, so one rejected command cannot pin the error toast until reload.
  if (!refused) patch({ lastError: null });
}

export function installDevMock(): void {
  console.warn("[hoolypane] DEV MOCK chrome bridge active (no Electron preload detected)");
  Object.defineProperty(window, "hoolypaneChrome", {
    configurable: true,
    value: Object.freeze({
      subscribe(callback: (value: unknown) => void): () => void {
        listeners.add(callback);
        queueMicrotask(() => callback(mockState));
        return () => {
          listeners.delete(callback);
        };
      },
      send(command: ChromeCommand): void {
        // Same validation the preload and main layers perform; rejections are logged and dropped.
        const parsed = ChromeCommandSchema.safeParse(command);
        if (!parsed.success) {
          console.error("[hoolypane dev-mock] rejected chrome command", parsed.error.message);
          return;
        }
        apply(parsed.data);
      },
      sendBounds(bounds: BoundsSnapshot): void {
        const parsed = BoundsSnapshotSchema.safeParse(bounds);
        if (!parsed.success) console.error("[hoolypane dev-mock] rejected bounds snapshot", parsed.error.message);
      },
    }),
  });
}
