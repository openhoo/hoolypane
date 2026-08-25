import type { ElectronApplication, Page } from "playwright";
import { errorMessage } from "@hoolypane/contracts";

/**
 * Clicks a fixture element inside the 1440px source pane through CDP input dispatch,
 * mirroring PaneRegistry.getInputScale: Electron routes pointer coordinates against the
 * visible (viewport-clipped) view bounds, so the scale derives from the clamped area.
 * With expectedStatus the click is retried up to three times until the fixture reports
 * the expected status; without it the click is dispatched exactly once (a blind retry
 * could double-toggle toggles such as the subscribe checkbox).
 */
export async function clickPaneSurface(
  application: ElectronApplication,
  chrome: Page,
  options: { port: number; testId: string; expectedStatus?: string },
): Promise<void> {
  const surface = await chrome.locator('[data-pane-surface="desktop-1440"]').boundingBox();
  if (!surface) throw new Error("desktop source surface missing");
  const viewport = await chrome.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const visibleWidth = Math.max(0, Math.min(viewport.width, surface.x + surface.width) - Math.max(0, surface.x));
  const visibleHeight = Math.max(0, Math.min(viewport.height, surface.y + surface.height) - Math.max(0, surface.y));
  const scale = Math.min(1, visibleWidth / 1440, visibleHeight / 900);
  const result = await application.evaluate(async ({ webContents }, input) => {
    const candidates = webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith(`http://127.0.0.1:${input.port}`));
    let source: (typeof candidates)[number] | undefined;
    for (const candidate of candidates) {
      if (await candidate.executeJavaScript("innerWidth") === 1440) { source = candidate; break; }
    }
    if (!source) throw new Error("desktop source pane missing");
    let lastError: string | undefined;
    let status: string | null | undefined;
    const attempts = input.expectedStatus === undefined ? 1 : 3;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const box = await source.executeJavaScript(`(() => {
          const element = document.querySelector('[data-testid="${input.testId}"]');
          element.scrollIntoView({ block: "center", inline: "center" });
          return element.getBoundingClientRect().toJSON();
        })()`);
        const x = (box.x + box.width / 2) * input.scale;
        const y = (box.y + box.height / 2) * input.scale;
        await source.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await source.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        status = await source.executeJavaScript(`document.querySelector('[data-testid="status"]')?.textContent ?? null`);
        if (input.expectedStatus === undefined || status === input.expectedStatus) {
          return { status, attempts, lastAttempt: attempt, lastError };
        }
      } catch (error) {
        // Transient renderer reloads invalidate execution contexts mid-attempt; retry instead of aborting.
        lastError = errorMessage(error);
        status = undefined;
      }
      const { promise: settleDelay, resolve: settleDone } = Promise.withResolvers<void>();
      setTimeout(settleDone, 150);
      await settleDelay;
    }
    return { status, attempts, lastAttempt: attempts, lastError };
  }, { port: options.port, testId: options.testId, scale, expectedStatus: options.expectedStatus });
  if (options.expectedStatus !== undefined && result.status !== options.expectedStatus) {
    throw new Error(`source ${options.testId} click did not activate: ${JSON.stringify({ surface, scale, result })}`);
  }
}
