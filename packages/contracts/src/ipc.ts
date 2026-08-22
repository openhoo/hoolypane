import { z } from "zod";
import { ActionSchema } from "./action.js";
import { ColorSchemeModeSchema, LayoutModeSchema, OverlayKeySchema, ThrottlingModeSchema } from "./state.js";
import { ViewportSpecSchema } from "./viewport.js";

export const IPC_CHANNELS = {
  command: "hoolypane:command",
  bounds: "hoolypane:bounds",
  paneAction: "hoolypane:pane-action",
  paneGeneration: "hoolypane:pane-generation",
  replay: "hoolypane:replay",
  replayResult: "hoolypane:replay-result",
  flush: "hoolypane:flush",
  state: "hoolypane:state",
  stateRequest: "hoolypane:state-request",
} as const;

const paneId = z.string().min(1);
const IntegerBoundsSchema = z.strictObject({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
});
export const BoundsSnapshotSchema = z.strictObject({
  windowWidth: z.number().int().positive(),
  windowHeight: z.number().int().positive(),
  panes: z.array(z.strictObject({ paneId, bounds: IntegerBoundsSchema })),
});

export const ChromeCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("create"), viewport: ViewportSpecSchema }),
  z.strictObject({ kind: z.literal("close"), paneId }),
  z.strictObject({ kind: z.literal("duplicate"), paneId }),
  z.strictObject({ kind: z.literal("rename"), paneId, name: z.string().min(1) }),
  z.strictObject({ kind: z.literal("reorder"), paneId, index: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal("resize"), paneId, width: z.number().int().positive(), height: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("rotate"), paneId }),
  z.strictObject({ kind: z.literal("focus"), paneId: paneId.nullable() }),
  z.strictObject({ kind: z.literal("navigate"), url: z.string().min(1) }),
  z.strictObject({ kind: z.enum(["back", "forward", "reload"]), paneId }),
  z.strictObject({ kind: z.literal("set-layout"), layout: LayoutModeSchema }),
  z.strictObject({ kind: z.literal("move-pane"), paneId, x: z.number().int().min(0), y: z.number().int().min(0) }),
  z.strictObject({ kind: z.literal("set-sync"), enabled: z.boolean() }),
  z.strictObject({ kind: z.literal("set-color-scheme"), value: ColorSchemeModeSchema }),
  z.strictObject({ kind: z.literal("set-reduced-motion"), enabled: z.boolean() }),
  z.strictObject({ kind: z.literal("set-throttling"), mode: ThrottlingModeSchema }),
  z.strictObject({ kind: z.literal("set-overlay"), key: OverlayKeySchema, enabled: z.boolean() }),
  z.strictObject({ kind: z.enum(["capture-pane"]), paneId }),
  z.strictObject({ kind: z.enum(["capture-overview", "record-start", "record-stop"]) }),
]);

export const PaneObservedActionSchema = z.strictObject({
  documentGeneration: z.number().int().nonnegative(),
  action: ActionSchema,
});
export const PaneGenerationSchema = z.strictObject({
  documentGeneration: z.number().int().nonnegative(),
});
const REPLAY_PHASES = ["resolve", "apply-dom", "end"] as const;
export const ReplayRequestSchema = z.strictObject({
  actionId: z.number().int().positive(),
  documentGeneration: z.number().int().nonnegative(),
  action: ActionSchema,
  phase: z.enum(REPLAY_PHASES),
});
export const ReplayResultSchema = z.strictObject({
  actionId: z.number().int().positive(),
  paneId: paneId.optional(),
  phase: z.enum([...REPLAY_PHASES, "confirm"]),
  ok: z.boolean(),
  reason: z.string().max(512).optional(),
  box: z.strictObject({ x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() }).optional(),
  checked: z.boolean().optional(),
});

export type BoundsSnapshot = z.infer<typeof BoundsSnapshotSchema>;
export type ChromeCommand = z.infer<typeof ChromeCommandSchema>;
export type ReplayRequest = z.infer<typeof ReplayRequestSchema>;
export type ReplayResult = z.infer<typeof ReplayResultSchema>;
