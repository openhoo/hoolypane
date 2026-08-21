import type { ViewportSpec } from "@hoolypane/contracts";
import { VIEWPORT_PRESETS } from "@hoolypane/contracts";
type RendererPaneState = { id: string; name: string; viewport: ViewportSpec; url: string; canGoBack: boolean; canGoForward: boolean; loading: boolean; failure: string | null; outOfSync: { actionId: number; actionKind: string; reason: string } | null };
type RendererWorkspace = { version: 1; panes: RendererPaneState[]; order: string[]; layout: "grid" | "horizontal" | "focus"; focusedPaneId: string | null; syncEnabled: boolean; sharedUrl: string; recording?: boolean };

type WorkspaceState = RendererWorkspace;

export type ChromeState = WorkspaceState;
type ChromeAction = { type: "state"; state: WorkspaceState };

export function initialChromeState(): ChromeState {
  const panes = VIEWPORT_PRESETS.map((viewport) => ({ id: viewport.id, name: viewport.name, viewport, url: "https://example.com/", canGoBack: false, canGoForward: false, loading: false, failure: null, outOfSync: null }));
  return { version: 1, panes, order: panes.map((pane) => pane.id), layout: "grid", focusedPaneId: null, syncEnabled: true, sharedUrl: "https://example.com/", recording: false };
}
export function chromeReducer(_state: ChromeState, action: ChromeAction): ChromeState {
  return action.state;
}
export function customViewport(width: number, height: number): ViewportSpec {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  return { id: `custom-${safeWidth}x${safeHeight}`, name: `Custom ${safeWidth}×${safeHeight}`, width: safeWidth, height: safeHeight, deviceScaleFactor: 1, isMobile: false, hasTouch: false };
}
