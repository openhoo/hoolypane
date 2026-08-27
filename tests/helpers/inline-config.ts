import type { ViewportSpec } from "@hoolypane/contracts";
import { FIXTURE_RECORDING_TAIL } from "../fixtures/hoolypane.config.js";

function viewportLiteral(viewport: ViewportSpec): string {
  return `{ ${Object.entries(viewport).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(", ")} }`;
}

/** Emits the inline runner-config source shared by the integration suites: one self-contained
 *  defineConfig(...) statement written beside (never inside) the wiped output directory. Both the
 *  recording block and the viewport fields derive from contracts/fixtures at runtime — nothing
 *  here is hand-synced, so a ViewportSpec schema extension flows into generated configs instead of
 *  silently diverging from the checked-in one. */
export function inlineConfigSource(baseURL: string, viewports: readonly ViewportSpec[], timeoutMs?: number): string {
  const timeout = timeoutMs === undefined ? "" : `, timeoutMs: ${timeoutMs}`;
  return `import { defineConfig } from "@hoolypane/runner"; export default defineConfig({ baseURL: ${JSON.stringify(baseURL)}${timeout}, viewports: [${viewports.map(viewportLiteral).join(", ")}], ${FIXTURE_RECORDING_TAIL} });`;
}
