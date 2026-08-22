import type { PaneState, ViewportSpec, WorkspaceState } from "@hoolypane/contracts";

export { WorkspaceStateSchema, defaultWorkspace } from "@hoolypane/contracts";
export type { PaneState, WorkspaceState } from "@hoolypane/contracts";

export function uniquePaneId(used: ReadonlySet<string>, seed: string): string {
  if (!used.has(seed)) return seed;
  let suffix = 2;
  while (used.has(`${seed}-${suffix}`)) suffix += 1;
  return `${seed}-${suffix}`;
}

/** Removes a pane unconditionally (no last-pane guard); used by create rollback. */
export function removePane(workspace: WorkspaceState, paneId: string): WorkspaceState {
  if (!workspace.order.includes(paneId)) return workspace;
  const focusedPaneId = workspace.focusedPaneId === paneId ? null : workspace.focusedPaneId;
  const layout = workspace.focusedPaneId === paneId && workspace.layout === "focus" ? "grid" : workspace.layout;
  return { ...workspace, panes: workspace.panes.filter((pane) => pane.id !== paneId), order: workspace.order.filter((id) => id !== paneId), focusedPaneId, layout };
}

export function addPane(workspace: WorkspaceState, viewport: ViewportSpec, url = workspace.sharedUrl, id: string = uniquePaneId(new Set(workspace.order), viewport.id)): WorkspaceState {
  const pane: PaneState = { id, name: viewport.name, viewport, url, canGoBack: false, canGoForward: false, loading: false, failure: null, outOfSync: null };
  return { ...workspace, panes: [...workspace.panes, pane], order: [...workspace.order, id] };
}

export function closePane(workspace: WorkspaceState, paneId: string): WorkspaceState {
  if (workspace.panes.length === 1 || !workspace.order.includes(paneId)) return workspace;
  return removePane(workspace, paneId);
}

export function duplicatePane(workspace: WorkspaceState, paneId: string): WorkspaceState {
  const source = workspace.panes.find((pane) => pane.id === paneId);
  if (!source) return workspace;
  const id = uniquePaneId(new Set(workspace.order), source.id);
  const pane = { ...source, id, name: `${source.name} copy`, viewport: { ...source.viewport, id } };
  const sourceIndex = workspace.order.indexOf(paneId);
  const order = [...workspace.order];
  order.splice(sourceIndex + 1, 0, id);
  return { ...workspace, panes: [...workspace.panes, pane], order };
}

export function updatePane(workspace: WorkspaceState, paneId: string, update: (pane: PaneState) => PaneState): WorkspaceState {
  if (!workspace.order.includes(paneId)) return workspace;
  return { ...workspace, panes: workspace.panes.map((pane) => pane.id === paneId ? update(pane) : pane) };
}

export function reorderPane(workspace: WorkspaceState, paneId: string, index: number): WorkspaceState {
  const current = workspace.order.indexOf(paneId);
  if (current < 0) return workspace;
  const order = [...workspace.order];
  order.splice(current, 1);
  order.splice(Math.min(index, order.length), 0, paneId);
  return { ...workspace, order };
}

export function rotatePane(workspace: WorkspaceState, paneId: string): WorkspaceState {
  return updatePane(workspace, paneId, (pane) => ({ ...pane, viewport: { ...pane.viewport, width: pane.viewport.height, height: pane.viewport.width } }));
}
