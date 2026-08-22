import { defaultWorkspace, type ChromeState, type ViewportSpec } from "@hoolypane/contracts";

export type { ChromeState };
type ChromeAction = { type: "state"; state: ChromeState };

export function initialChromeState(): ChromeState {
  return { ...defaultWorkspace(), recording: false, lastError: null };
}
export function chromeReducer(_state: ChromeState, action: ChromeAction): ChromeState {
  return action.state;
}
export function customViewport(width: number, height: number): ViewportSpec {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  return { id: `custom-${safeWidth}x${safeHeight}`, name: `Custom ${safeWidth}×${safeHeight}`, width: safeWidth, height: safeHeight, deviceScaleFactor: 1, isMobile: false, hasTouch: false };
}
