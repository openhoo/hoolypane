import { VIEWPORT_PRESETS, ViewportSpecSchema, ActionSchema, type ViewportSpec, type Action } from "@hoolypane/contracts";
import { z } from "zod";

const LayoutModeSchema = z.enum(["grid", "horizontal", "focus"]);

const HttpUrlSchema = z.url({ protocol: /^https?$/ });
const ActionKinds = ActionSchema.options.map((option) => option.shape.kind.value) as [Action["kind"], ...Action["kind"][]];
const ActionKindSchema = z.enum(ActionKinds);

const PaneStateSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  viewport: ViewportSpecSchema,
  url: HttpUrlSchema,
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  loading: z.boolean(),
  failure: z.string().nullable(),
  outOfSync: z.strictObject({
    actionId: z.number().int().positive(),
    actionKind: ActionKindSchema,
    reason: z.string().min(1),
  }).nullable(),
});
export type PaneState = z.infer<typeof PaneStateSchema>;

export const WorkspaceStateSchema = z.strictObject({
  version: z.literal(1),
  panes: z.array(PaneStateSchema).min(1),
  order: z.array(z.string().min(1)).min(1),
  layout: LayoutModeSchema,
  focusedPaneId: z.string().min(1).nullable(),
  syncEnabled: z.boolean(),
  sharedUrl: HttpUrlSchema,
}).superRefine((workspace, context) => {
  const paneIds = workspace.panes.map((pane) => pane.id);
  const uniquePaneIds = new Set(paneIds);
  if (uniquePaneIds.size !== paneIds.length) context.addIssue({ code: "custom", path: ["panes"], message: "pane ids must be unique" });
  if (new Set(workspace.order).size !== workspace.order.length || workspace.order.length !== paneIds.length || workspace.order.some((id) => !uniquePaneIds.has(id))) {
    context.addIssue({ code: "custom", path: ["order"], message: "order must contain every pane id exactly once" });
  }
  if (workspace.focusedPaneId !== null && !uniquePaneIds.has(workspace.focusedPaneId)) {
    context.addIssue({ code: "custom", path: ["focusedPaneId"], message: "focused pane must exist" });
  }
});
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;

export function defaultWorkspace(url = "https://example.com/"): WorkspaceState {
  const viewports = VIEWPORT_PRESETS;
  const panes = viewports.map((viewport) => paneFromViewport(viewport, viewport.id, url));
  return { version: 1, panes, order: panes.map((pane) => pane.id), layout: "grid", focusedPaneId: null, syncEnabled: true, sharedUrl: url };
}

function paneFromViewport(viewport: ViewportSpec, id: string, url: string): PaneState {
  return { id, name: viewport.name, viewport, url, canGoBack: false, canGoForward: false, loading: false, failure: null, outOfSync: null };
}

function uniquePaneId(workspace: WorkspaceState, seed: string): string {
  const used = new Set(workspace.order);
  if (!used.has(seed)) return seed;
  let suffix = 2;
  while (used.has(`${seed}-${suffix}`)) suffix += 1;
  return `${seed}-${suffix}`;
}

export function addPane(workspace: WorkspaceState, viewport: ViewportSpec, url = workspace.sharedUrl, id: string = uniquePaneId(workspace, viewport.id)): WorkspaceState {
  const pane = paneFromViewport(viewport, id, url);
  return { ...workspace, panes: [...workspace.panes, pane], order: [...workspace.order, id] };
}

export function closePane(workspace: WorkspaceState, paneId: string): WorkspaceState {
  if (workspace.panes.length === 1 || !workspace.order.includes(paneId)) return workspace;
  const focusedPaneId = workspace.focusedPaneId === paneId ? null : workspace.focusedPaneId;
  const layout = workspace.focusedPaneId === paneId && workspace.layout === "focus" ? "grid" : workspace.layout;
  return { ...workspace, panes: workspace.panes.filter((pane) => pane.id !== paneId), order: workspace.order.filter((id) => id !== paneId), focusedPaneId, layout };
}

export function duplicatePane(workspace: WorkspaceState, paneId: string): WorkspaceState {
  const source = workspace.panes.find((pane) => pane.id === paneId);
  if (!source) return workspace;
  const id = uniquePaneId(workspace, source.id);
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
