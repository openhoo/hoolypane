import { z } from "zod";

const nonEmpty = z.string().min(1);
export const TestIdLocatorSchema = z.strictObject({ kind: z.literal("testId"), value: nonEmpty });
export const RoleLocatorSchema = z.strictObject({ kind: z.literal("role"), role: nonEmpty, name: nonEmpty });
export const LabelLocatorSchema = z.strictObject({ kind: z.literal("label"), value: nonEmpty });
export const PlaceholderLocatorSchema = z.strictObject({ kind: z.literal("placeholder"), value: nonEmpty });
export const TextLocatorSchema = z.strictObject({ kind: z.literal("text"), value: nonEmpty });
export const CssLocatorSchema = z.strictObject({ kind: z.literal("css"), value: nonEmpty });

export const LocatorSpecSchema = z.discriminatedUnion("kind", [
  TestIdLocatorSchema,
  RoleLocatorSchema,
  LabelLocatorSchema,
  PlaceholderLocatorSchema,
  TextLocatorSchema,
  CssLocatorSchema,
]);
export type LocatorSpec = z.infer<typeof LocatorSpecSchema>;
export const LOCATOR_PRIORITY: readonly LocatorSpec["kind"][] = ["testId", "role", "label", "placeholder", "text", "css"];

const target = { locator: LocatorSpecSchema };
export const ActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("navigate"), url: z.string().url() }),
  z.strictObject({ kind: z.literal("click"), ...target }),
  z.strictObject({ kind: z.literal("fill"), ...target, value: z.string() }),
  z.strictObject({ kind: z.literal("select"), ...target, values: z.array(z.string()).min(1) }),
  z.strictObject({ kind: z.literal("check"), ...target, checked: z.boolean() }),
  z.strictObject({ kind: z.literal("press"), ...target, key: nonEmpty }),
  z.strictObject({
    kind: z.literal("scroll"),
    ...target,
    horizontalRatio: z.number().min(0).max(1),
    verticalRatio: z.number().min(0).max(1),
  }),
]);
export type Action = z.infer<typeof ActionSchema>;

export const ActionEnvelopeSchema = z.strictObject({
  actionId: z.number().int().positive(),
  documentGeneration: z.number().int().nonnegative(),
  sourcePaneId: nonEmpty,
  action: ActionSchema,
  recordedAtUnixMs: z.number().int().nonnegative(),
});
export type ActionEnvelope = z.infer<typeof ActionEnvelopeSchema>;
