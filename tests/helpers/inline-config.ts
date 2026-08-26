import type { ViewportSpec } from "@hoolypane/contracts";

// Hand-synced recording tail of the inline integration configs; both suites must parse identical values.
const RECORDING_TAIL = "recording: { fps: 30, jpegQuality: 70, compositeMaxSize: { width: 640, height: 480 }, keepRaw: false }";

function viewportLiteral(viewport: ViewportSpec): string {
  return `{ id: ${JSON.stringify(viewport.id)}, name: ${JSON.stringify(viewport.name)}, width: ${viewport.width}, height: ${viewport.height}, deviceScaleFactor: ${viewport.deviceScaleFactor}, isMobile: ${viewport.isMobile}, hasTouch: ${viewport.hasTouch} }`;
}

/** Emits the inline runner-config source shared by the integration suites: one self-contained
 *  defineConfig(...) statement written beside (never inside) the wiped output directory. */
export function inlineConfigSource(baseURL: string, viewports: readonly ViewportSpec[], timeoutMs?: number): string {
  const timeout = timeoutMs === undefined ? "" : `, timeoutMs: ${timeoutMs}`;
  return `import { defineConfig } from "@hoolypane/runner"; export default defineConfig({ baseURL: "${baseURL}"${timeout}, viewports: [${viewports.map(viewportLiteral).join(", ")}], ${RECORDING_TAIL} });`;
}
