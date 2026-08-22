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
import { BoundsSnapshotSchema, ChromeStateSchema } from "@hoolypane/contracts";
import type { BoundsSnapshot, ChromeCommand, ChromeState, PaneState } from "@hoolypane/contracts";
import { initialChromeState } from "./state.js";

let mockState: ChromeState = initialChromeState();
const listeners = new Set<(value: unknown) => void>();
let loadingTimer: number | undefined;

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

function settleLoading(paneIds: readonly string[]): void {
  window.clearTimeout(loadingTimer);
  loadingTimer = window.setTimeout(() => {
    patch({ panes: mockState.panes.map((pane) => (paneIds.includes(pane.id) ? { ...pane, loading: false } : pane)) });
  }, 600);
}

function normalizeUrl(raw: string): string {
  try {
    return new URL(/^[a-z][a-z\d+\-.]*:/i.test(raw) ? raw : `https://${raw}`).toString();
  } catch {
    return mockState.sharedUrl;
  }
}

function uniqueId(base: string): string {
  const taken = new Set(mockState.panes.map((pane) => pane.id));
  let candidate = base;
  let counter = 2;
  while (taken.has(candidate)) candidate = `${base}-${counter++}`;
  return candidate;
}

function apply(command: ChromeCommand): void {
  switch (command.kind) {
    case "navigate": {
      const url = normalizeUrl(command.url);
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
      const id = uniqueId(command.viewport.id);
      const pane: PaneState = {
        id,
        name: command.viewport.name,
        viewport: command.viewport,
        url: mockState.sharedUrl,
        canGoBack: false,
        canGoForward: false,
        loading: false,
        failure: null,
        outOfSync: null,
      };
      patch({ panes: [...mockState.panes, pane], order: [...mockState.order, id] });
      break;
    }
    case "close": {
      if (mockState.order.length <= 1) break;
      patch({
        panes: mockState.panes.filter((pane) => pane.id !== command.paneId),
        order: mockState.order.filter((id) => id !== command.paneId),
        focusedPaneId: mockState.focusedPaneId === command.paneId ? null : mockState.focusedPaneId,
      });
      break;
    }
    case "duplicate": {
      const source = mockState.panes.find((pane) => pane.id === command.paneId);
      if (!source) break;
      const id = uniqueId(`${source.id}-copy`);
      const copy: PaneState = { ...source, id, name: `${source.name} copy`, outOfSync: null };
      const order = [...mockState.order];
      order.splice(order.indexOf(source.id) + 1, 0, id);
      patch({ panes: [...mockState.panes, copy], order });
      break;
    }
    case "rename":
      patchPane(command.paneId, { name: command.name });
      break;
    case "reorder": {
      const from = mockState.order.indexOf(command.paneId);
      if (from < 0) break;
      const order = [...mockState.order];
      order.splice(from, 1);
      order.splice(Math.min(command.index, order.length), 0, command.paneId);
      patch({ order });
      break;
    }
    case "resize": {
      const pane = mockState.panes.find((candidate) => candidate.id === command.paneId);
      if (!pane) break;
      patchPane(command.paneId, { viewport: { ...pane.viewport, width: command.width, height: command.height } });
      break;
    }
    case "rotate": {
      const pane = mockState.panes.find((candidate) => candidate.id === command.paneId);
      if (!pane) break;
      patchPane(command.paneId, {
        viewport: { ...pane.viewport, width: pane.viewport.height, height: pane.viewport.width },
      });
      break;
    }
    case "focus":
      patch({ focusedPaneId: command.paneId });
      break;
    case "set-layout":
      patch({ layout: command.layout });
      break;
    case "set-sync":
      patch({ syncEnabled: command.enabled });
      break;
    case "capture-pane":
    case "capture-overview":
      // Screenshots require the native WebContentsView; no-op success in the mock.
      break;
    case "record-start":
      patch({ recording: true });
      break;
    case "record-stop":
      patch({ recording: false });
      break;
  }
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
      send: apply,
      sendBounds(bounds: BoundsSnapshot): void {
        const parsed = BoundsSnapshotSchema.safeParse(bounds);
        if (!parsed.success) console.error("[hoolypane dev-mock] rejected bounds snapshot", parsed.error.message);
      },
    }),
  });
}
