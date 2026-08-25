import { z } from "zod";

// libvpx's VP8 encoder rejects any dimension above 16383 px ("Invalid parameter", verified against the pinned
// ffmpeg-static build); per-track videos encode at exactly these dimensions, so the schema enforces the codec
// limit itself instead of the historical 16384 surface cap.
export const MAX_ENCODED_DIMENSION = 16_383;
const MAX_ENCODED_AREA = 67_108_864;
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// The encoder emits the grid video as videos/composite.webm next to videos/<id>.webm;
// a viewport literally named "composite" would overwrite it.
const RESERVED_COMPOSITE_ID = "composite";

export function encodedDimension(cssDimension: number, deviceScaleFactor: number): number {
  const raw = cssDimension * deviceScaleFactor;
  const snapped = Math.round(raw * 1e6) / 1e6;
  return 2 * Math.ceil(snapped / 2);
}

export const ViewportSpecSchema = z
  .strictObject({
    id: z.string().min(1).regex(slug, "id must be a lowercase slug"),
    name: z.string().min(1),
    width: z.number().int().min(1).max(MAX_ENCODED_DIMENSION),
    height: z.number().int().min(1).max(MAX_ENCODED_DIMENSION),
    deviceScaleFactor: z.number().min(0.5).max(4),
    isMobile: z.boolean(),
    hasTouch: z.boolean(),
  })
  .superRefine((viewport, context) => {
    const width = encodedDimension(viewport.width, viewport.deviceScaleFactor);
    const height = encodedDimension(viewport.height, viewport.deviceScaleFactor);
    if (width > MAX_ENCODED_DIMENSION || height > MAX_ENCODED_DIMENSION) {
      context.addIssue({ code: "custom", message: `encoded dimensions ${width}x${height} exceed ${MAX_ENCODED_DIMENSION}` });
    }
    if (width * height > MAX_ENCODED_AREA) {
      context.addIssue({ code: "custom", message: `encoded area ${width * height} exceeds ${MAX_ENCODED_AREA}` });
    }
  });

export type ViewportSpec = z.infer<typeof ViewportSpecSchema>;

export const ViewportListSchema = z.array(ViewportSpecSchema).min(1).superRefine((viewports, context) => {
  const ids = new Set<string>();
  for (const [index, viewport] of viewports.entries()) {
    if (ids.has(viewport.id)) {
      context.addIssue({ code: "custom", path: [index, "id"], message: `duplicate viewport id: ${viewport.id}` });
    }
    if (viewport.id === RESERVED_COMPOSITE_ID) {
      context.addIssue({ code: "custom", path: [index, "id"], message: `reserved viewport id: "${RESERVED_COMPOSITE_ID}" collides with the encoded composite.webm artifact` });
    }
    ids.add(viewport.id);
  }
});
