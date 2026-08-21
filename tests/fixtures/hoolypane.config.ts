import { defineConfig } from "@hoolypane/runner";

export default defineConfig({
  baseURL: "http://127.0.0.1:4174",
  timeoutMs: 10_000,
  viewports: [
    { id: "desktop", name: "Desktop", width: 320, height: 240, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
    { id: "tablet", name: "Tablet", width: 240, height: 320, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
    { id: "phone", name: "Phone", width: 180, height: 320, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  ],
  recording: { fps: 30, jpegQuality: 70, compositeMaxSize: { width: 640, height: 480 }, keepRaw: false },
});
