import { z } from "zod";
import { HttpUrlSchema } from "./action.js";
import { MAX_ENCODED_DIMENSION, ViewportListSchema } from "./viewport.js";

const RecordingInputSchema = z.strictObject({
  fps: z.union([z.literal(30), z.literal(60)]).default(60),
  jpegQuality: z.number().int().min(0).max(100).default(85),
  compositeMaxSize: z
    .strictObject({
      width: z.number().int().min(2).max(MAX_ENCODED_DIMENSION),
      height: z.number().int().min(2).max(MAX_ENCODED_DIMENSION),
    })
    .prefault({ width: 3840, height: 2160 }),
  compositeBackground: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#111318"),
  outputDir: z.string().min(1).default("hoolypane-results"),
  keepRaw: z.boolean().default(false),
});

export const HoolypaneConfigSchema = z.strictObject({
  baseURL: HttpUrlSchema.optional(),
  viewports: ViewportListSchema,
  storageState: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().default(30_000),
  recording: RecordingInputSchema.prefault({}),
});

export type HoolypaneConfig = z.input<typeof HoolypaneConfigSchema>;
export type ResolvedHoolypaneConfig = Readonly<z.output<typeof HoolypaneConfigSchema>>;
export type ResolvedRecordingConfig = ResolvedHoolypaneConfig["recording"];
