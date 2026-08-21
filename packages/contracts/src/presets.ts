import { ViewportListSchema, type ViewportSpec } from "./viewport.js";

export const VIEWPORT_PRESETS: readonly ViewportSpec[] = ViewportListSchema.parse([
  { id: "desktop-1440", name: "Desktop 1440", width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { id: "laptop-1280", name: "Laptop 1280", width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { id: "tablet-768", name: "Tablet 768", width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { id: "phone-390", name: "Phone 390", width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { id: "phone-360", name: "Phone 360", width: 360, height: 800, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
]);
