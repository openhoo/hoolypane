import { describe, expect, it } from "vitest";
import { encodedDimension, ViewportListSchema, ViewportSpecSchema } from "./viewport.js";
import { VIEWPORT_PRESETS } from "./presets.js";

describe("viewport contracts", () => {
  it("ships the exact five presets", () => {
    expect(VIEWPORT_PRESETS.map(({ id, width, height, deviceScaleFactor, isMobile, hasTouch }) => ({ id, width, height, deviceScaleFactor, isMobile, hasTouch }))).toEqual([
      { id: "desktop-1440", width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
      { id: "laptop-1280", width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
      { id: "tablet-768", width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
      { id: "phone-390", width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
      { id: "phone-360", width: 360, height: 800, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    ]);
  });

  it("rounds encoded dimensions to even pixels", () => {
    expect(encodedDimension(391, 1.5)).toBe(588);
  });

  it("rejects duplicate ids and unsafe encoded geometry", () => {
    expect(ViewportListSchema.safeParse([VIEWPORT_PRESETS[0], VIEWPORT_PRESETS[0]]).success).toBe(false);
    expect(ViewportSpecSchema.safeParse({ id: "unsafe", name: "Unsafe", width: 16_384, height: 16_384, deviceScaleFactor: 4, isMobile: false, hasTouch: false }).success).toBe(false);
    expect(ViewportSpecSchema.safeParse({ ...VIEWPORT_PRESETS[0], id: "Not A Slug" }).success).toBe(false);
  });
});
