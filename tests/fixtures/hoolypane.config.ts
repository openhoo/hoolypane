import { defineConfig } from "@hoolypane/runner";
import { FIXTURE_BASE_URL } from "./ports.js";

/** Single home of the recording parameters shared by this checked-in config and every generated inline config. */
export const FIXTURE_RECORDING = {
  fps: 30,
  jpegQuality: 70,
  compositeMaxSize: { width: 640, height: 480 },
  keepRaw: false,
} as const;

const renderRecordingTail = (recording: typeof FIXTURE_RECORDING): string =>
  `recording: { fps: ${recording.fps}, jpegQuality: ${recording.jpegQuality}, compositeMaxSize: { width: ${recording.compositeMaxSize.width}, height: ${recording.compositeMaxSize.height} }, keepRaw: ${recording.keepRaw} }`;

/** Serialized recording block injected verbatim into generated inline configs; derived above, never hand-synced. */
export const FIXTURE_RECORDING_TAIL = renderRecordingTail(FIXTURE_RECORDING);

export default defineConfig({
  baseURL: FIXTURE_BASE_URL,
  timeoutMs: 10_000,
  viewports: [
    { id: "desktop", name: "Desktop", width: 320, height: 240, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
    { id: "tablet", name: "Tablet", width: 240, height: 320, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
    { id: "phone", name: "Phone", width: 180, height: 320, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  ],
  recording: FIXTURE_RECORDING,
});
