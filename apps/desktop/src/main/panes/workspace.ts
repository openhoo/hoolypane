import { paneFromViewport } from "@hoolypane/contracts";
import type { PaneState, ViewportSpec, WorkspaceState } from "@hoolypane/contracts";

export { WorkspaceStateSchema, defaultWorkspace } from "@hoolypane/contracts";
export type { PaneState, WorkspaceState } from "@hoolypane/contracts";

export function uniquePaneId(used: ReadonlySet<string>, seed: string): string {
  if (!used.has(seed)) return seed;
  let suffix = 2;
  while (used.has(`${seed}-${suffix}`)) suffix += 1;
  return `${seed}-${suffix}`;
}

export function hasPane(workspace: WorkspaceState, paneId: string): boolean {
  return workspace.order.includes(paneId);
}

/** Removes a pane unconditionally (no last-pane guard); used by create rollback. */
export function removePane(workspace: WorkspaceState, paneId: string): WorkspaceState {
  if (!hasPane(workspace, paneId)) return workspace;
  const focusedPaneId = workspace.focusedPaneId === paneId ? null : workspace.focusedPaneId;
  const layout = workspace.focusedPaneId === paneId && workspace.layout === "focus" ? "grid" : workspace.layout;
  // Positions have no lifecycle of their own: dropping the pane must drop its saved position,
  // otherwise restart-persistent orphans leak and a reused preset id inherits a stale position.
  const positions = { ...workspace.positions };
  delete positions[paneId];
  return { ...workspace, panes: workspace.panes.filter((pane) => pane.id !== paneId), order: workspace.order.filter((id) => id !== paneId), focusedPaneId, layout, positions };
}

export function addPane(workspace: WorkspaceState, viewport: ViewportSpec, url = workspace.sharedUrl, id: string = uniquePaneId(new Set(workspace.order), viewport.id)): WorkspaceState {
  const pane = paneFromViewport(viewport, id, url);
  return { ...workspace, panes: [...workspace.panes, pane], order: [...workspace.order, id] };
}

export function closePane(workspace: WorkspaceState, paneId: string): WorkspaceState {
  if (workspace.panes.length === 1 || !hasPane(workspace, paneId)) return workspace;
  return removePane(workspace, paneId);
}

export function updatePane(workspace: WorkspaceState, paneId: string, update: (pane: PaneState) => PaneState): WorkspaceState {
  if (!hasPane(workspace, paneId)) return workspace;
  return { ...workspace, panes: workspace.panes.map((pane) => pane.id === paneId ? update(pane) : pane) };
}

export function rotatePane(workspace: WorkspaceState, paneId: string): WorkspaceState {
  return updatePane(workspace, paneId, (pane) => ({ ...pane, viewport: { ...pane.viewport, width: pane.viewport.height, height: pane.viewport.width } }));
}
