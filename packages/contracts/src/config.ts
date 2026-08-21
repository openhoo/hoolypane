import { z } from "zod";
import { ViewportListSchema, type ViewportSpec } from "./viewport.js";

export const DEFAULT_RECORDING = {
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
    baseURL: z.string().url().optional(),
    viewports: ViewportListSchema,
    storageState: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    recording: RecordingInputSchema.optional(),
  })
  .transform((config) => ({
    ...config,
    timeoutMs: config.timeoutMs ?? 30_000,
    recording: {
      ...DEFAULT_RECORDING,
      ...config.recording,
      compositeMaxSize: config.recording?.compositeMaxSize ?? DEFAULT_RECORDING.compositeMaxSize,
    },
  }));

export type HoolypaneConfig = z.input<typeof HoolypaneConfigSchema>;
export interface ResolvedRecordingConfig {
  readonly fps: 30 | 60;
  readonly jpegQuality: number;
  readonly layout: "grid";
  readonly compositeMaxSize: { readonly width: number; readonly height: number };
  readonly compositeBackground: string;
  readonly outputDir: string;
  readonly keepRaw: boolean;
}
export interface ResolvedHoolypaneConfig {
  readonly baseURL?: string;
  readonly viewports: readonly ViewportSpec[];
  readonly storageState?: string;
  readonly timeoutMs: number;
  readonly recording: ResolvedRecordingConfig;
}
