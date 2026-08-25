import { z } from "zod";
import { HttpUrlSchema } from "./action.js";
import { ViewportListSchema } from "./viewport.js";

const DEFAULT_RECORDING = {
  fps: 60 as const,
  jpegQuality: 85,
  layout: "grid" as const,
  compositeMaxSize: { width: 3840, height: 2160 },
  compositeBackground: "#111318",
  outputDir: "hoolypane-results",
  keepRaw: false,
};

const RecordingInputSchema = z.strictObject({
  fps: z.union([z.literal(30), z.literal(60)]).optional(),
  jpegQuality: z.number().int().min(0).max(100).optional(),
  layout: z.literal("grid").optional(),
  compositeMaxSize: z.strictObject({ width: z.number().int().min(2).max(16_384), height: z.number().int().min(2).max(16_384) }).optional(),
  compositeBackground: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  outputDir: z.string().min(1).optional(),
  keepRaw: z.boolean().optional(),
});

export const HoolypaneConfigSchema = z
  .strictObject({
    baseURL: HttpUrlSchema.optional(),
    viewports: ViewportListSchema,
    storageState: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    recording: RecordingInputSchema.optional(),
  })
  .transform((config) => ({
    ...config,
    timeoutMs: config.timeoutMs ?? 30_000,
    recording: {
      fps: config.recording?.fps ?? DEFAULT_RECORDING.fps,
      jpegQuality: config.recording?.jpegQuality ?? DEFAULT_RECORDING.jpegQuality,
      layout: config.recording?.layout ?? DEFAULT_RECORDING.layout,
      compositeMaxSize: config.recording?.compositeMaxSize ?? DEFAULT_RECORDING.compositeMaxSize,
      compositeBackground: config.recording?.compositeBackground ?? DEFAULT_RECORDING.compositeBackground,
      outputDir: config.recording?.outputDir ?? DEFAULT_RECORDING.outputDir,
      keepRaw: config.recording?.keepRaw ?? DEFAULT_RECORDING.keepRaw,
    },
  }));

export type HoolypaneConfig = z.input<typeof HoolypaneConfigSchema>;
export type ResolvedHoolypaneConfig = Readonly<z.output<typeof HoolypaneConfigSchema>>;
export type ResolvedRecordingConfig = ResolvedHoolypaneConfig["recording"];
