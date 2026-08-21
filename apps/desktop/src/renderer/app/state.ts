import type { ViewportSpec } from "@hoolypane/contracts";
import { VIEWPORT_PRESETS } from "@hoolypane/contracts";
type RendererPaneState = { id: string; name: string; viewport: ViewportSpec; url: string; canGoBack: boolean; canGoForward: boolean; loading: boolean; failure: string | null; outOfSync: { actionId: number; actionKind: string; reason: string } | null };
type RendererWorkspace = { version: 1; panes: RendererPaneState[]; order: string[]; layout: "grid" | "horizontal" | "focus"; focusedPaneId: string | null; syncEnabled: boolean; sharedUrl: string; recording?: boolean };

type WorkspaceState = RendererWorkspace;

export type ChromeState = WorkspaceState & { error: string | null };
type ChromeAction =
  | { type: "state"; state: WorkspaceState }
  | { type: "error"; message: string }
  | { type: "url"; value: string }
  | { type: "clear-error" };

export function initialChromeState(): ChromeState {
  const panes = VIEWPORT_PRESETS.map((viewport) => ({ id: viewport.id, name: viewport.name, viewport, url: "https://example.com/", canGoBack: false, canGoForward: false, loading: false, failure: null, outOfSync: null }));
  return { version: 1, panes, order: panes.map((pane) => pane.id), layout: "grid", focusedPaneId: null, syncEnabled: true, sharedUrl: "https://example.com/", recording: false, error: null };
}
export function chromeReducer(state: ChromeState, action: ChromeAction): ChromeState {
  if (action.type === "state") return { ...action.state, error: null };
  if (action.type === "error") return { ...state, error: action.message };
  if (action.type === "clear-error") return { ...state, error: null };
  return state;
}
export function customViewport(width: number, height: number): ViewportSpec {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  return { id: `custom-${safeWidth}x${safeHeight}`, name: `Custom ${safeWidth}×${safeHeight}`, width: safeWidth, height: safeHeight, deviceScaleFactor: 1, isMobile: false, hasTouch: false };
}
