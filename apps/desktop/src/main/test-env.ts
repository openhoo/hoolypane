/** Canonical HOOLYPANE_TEST_* environment-knob names shared across the app/env seam.
 *  Production readers and every E2E consumer import these constants instead of retyping
 *  strings, so a rename can never drift between the two sides; runtime values are
 *  byte-identical to the previously hand-synced literals. */
export const TEST_MODE_ENV = "HOOLYPANE_TEST_MODE";
export const TEST_PANE_PNG_ENV = "HOOLYPANE_TEST_PANE_PNG";
export const TEST_OVERVIEW_PNG_ENV = "HOOLYPANE_TEST_OVERVIEW_PNG";
export const TEST_FLOW_PATH_ENV = "HOOLYPANE_TEST_FLOW_PATH";
export const TEST_FLOW_SAVE_CANCEL_ENV = "HOOLYPANE_TEST_FLOW_SAVE_CANCEL";
export const TEST_REPLAY_DELAY_MS_ENV = "HOOLYPANE_TEST_REPLAY_DELAY_MS";

/** Single source of truth for the TEST_MODE_ENV opt-in consumed by every test-only path. */
export function testModeEnabled(): boolean {
  return process.env[TEST_MODE_ENV] === "1";
}
