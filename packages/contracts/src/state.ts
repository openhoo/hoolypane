import { z } from "zod";
import { ActionSchema, HttpUrlSchema, type Action } from "./action.js";
import { VIEWPORT_PRESETS } from "./presets.js";
import { ViewportSpecSchema, type ViewportSpec } from "./viewport.js";

export const LayoutModeSchema = z.enum(["free", "grid", "horizontal", "focus"]);
export type LayoutMode = z.infer<typeof LayoutModeSchema>;

const PanePositionSchema = z.strictObject({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
});
export type PanePosition = z.infer<typeof PanePositionSchema>;
export const ColorSchemeModeSchema = z.enum(["auto", "light", "dark"]);
export type ColorSchemeMode = z.infer<typeof ColorSchemeModeSchema>;
export const ThrottlingModeSchema = z.enum(["none", "slow3g", "offline"]);
export type ThrottlingMode = z.infer<typeof ThrottlingModeSchema>;
export const OverlayKeySchema = z.enum(["outlines", "disableImages", "showRoles"]);
export type OverlayKey = z.infer<typeof OverlayKeySchema>;

const EmulationOverlaysSchema = z.strictObject({
  outlines: z.boolean().default(false),
  disableImages: z.boolean().default(false),
  showRoles: z.boolean().default(false),
});
/** Global emulation and debug-overlay settings applied to every pane via CDP; every key defaults so legacy workspaces load unchanged. */
const EmulationSettingsSchema = z.strictObject({
  colorScheme: ColorSchemeModeSchema.default("auto"),
  reducedMotion: z.boolean().default(false),
  throttling: ThrottlingModeSchema.default("none"),
  overlays: EmulationOverlaysSchema.prefault({}),
});
export type EmulationSettings = z.infer<typeof EmulationSettingsSchema>;

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
  /** Free-layout card positions in workspace coordinates; panes without an entry are auto-tiled. */
  positions: z.record(z.string().min(1), PanePositionSchema).default({}),
  emulation: EmulationSettingsSchema.prefault({}),
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

export const ChromeStateSchema = WorkspaceStateSchema.safeExtend({
  recording: z.boolean(),
  lastError: z.string().nullable(),
});
export type ChromeState = z.infer<typeof ChromeStateSchema>;

/** PaneState fields with no persistence lifecycle: reset on add and on load-time sanitize. */
export const RUNTIME_PANE_DEFAULTS = { canGoBack: false, canGoForward: false, loading: false, failure: null, outOfSync: null } as const;

export function paneFromViewport(viewport: ViewportSpec, id: string, url: string): PaneState {
  return { id, name: viewport.name, viewport, url, ...RUNTIME_PANE_DEFAULTS };
}

export function defaultWorkspace(): WorkspaceState {
  const url = "https://example.com/";
  const viewports = VIEWPORT_PRESETS;
  const panes = viewports.map((viewport) => paneFromViewport(viewport, viewport.id, url));
  return { version: 1, panes, order: panes.map((pane) => pane.id), layout: "free", positions: {}, emulation: EmulationSettingsSchema.parse({}), focusedPaneId: null, syncEnabled: true, sharedUrl: url };
}
