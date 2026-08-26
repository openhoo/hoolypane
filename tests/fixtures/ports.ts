/**
 * Single source of truth for the hand-assigned fixture server ports. The fixture
 * binds exactly one port (PORT env), and EADDRINUSE fails hard, so every suite,
 * the runner config baseURL, and the packaged-app smoke script must derive their
 * port from this module instead of repeating literals.
 *
 * Ports stay distinct per consumer so overlapping vitest workers and locally
 * running suites cannot collide.
 */

/** 4175 collided with an unrelated local dev stack; do not reuse it here. */
export const FIXTURE_PORTS = {
  /** tests/integration/runner.test.ts + tests/fixtures/hoolypane.config.ts baseURL */
  runner: 4174,
  /** tests/performance/desktop-benchmark.test.ts */
  benchmark: 4177,
  /** tests/integration/desktop-artifacts.test.ts */
  artifacts: 4178,
  /** tests/integration/desktop-resilience.test.ts */
  resilience: 4179,
  /** tests/integration/desktop.test.ts */
  desktop: 4185,
  /** tests/integration/desktop-dragdrop.test.ts */
  dragdrop: 4186,
  /** scripts/smoke-desktop-package.mjs */
  packageSmoke: 4188,
} as const;

/** Canonical origin string for any fixture port; the single construction point for test addressing. */
export const fixtureOrigin = (port: number): string => `http://127.0.0.1:${port}`;

/** Fixture base URL for the runner flow config; coupled to FIXTURE_PORTS.runner. */
export const FIXTURE_BASE_URL = fixtureOrigin(FIXTURE_PORTS.runner);
