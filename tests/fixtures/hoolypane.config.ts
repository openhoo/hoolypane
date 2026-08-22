import { defineConfig } from "@hoolypane/runner";
import { FIXTURE_BASE_URL } from "./ports.js";

export default defineConfig({
  baseURL: FIXTURE_BASE_URL,
  timeoutMs: 10_000,
  viewports: [
    { id: "desktop", name: "Desktop", width: 320, height: 240, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
    { id: "tablet", name: "Tablet", width: 240, height: 320, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
    { id: "phone", name: "Phone", width: 180, height: 320, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  ],
  recording: { fps: 30, jpegQuality: 70, compositeMaxSize: { width: 640, height: 480 }, keepRaw: false },
});
