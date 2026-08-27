import { cpSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import type { ElectronApplication, Page } from "playwright";
import { afterAll, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchDesktopApp, pollUntil, startFixtureServer, teardownDesktopSuite, waitForFixturePanes, type FixtureServer } from "../helpers/harness.js";
import { FIXTURE_PORTS, fixtureOrigin } from "../fixtures/ports.js";

const FIXTURE_PORT = FIXTURE_PORTS.dragdrop;

let fixture: FixtureServer | undefined;
let application!: ElectronApplication;
let chrome!: Page;
let userDataDir = "";

afterAll(() => teardownDesktopSuite(application, fixture, userDataDir), 30_000);

interface CardBox {
  readonly x: number;
  readonly y: number;
}

interface PaneBounds extends CardBox {
  readonly width: number;
  readonly height: number;
}

async function cardBoxes(page: Page): Promise<Map<string, CardBox>> {
  const raw = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".pane-card")).map((card) => ({
    id: card.querySelector("[data-pane-surface]")?.getAttribute("data-pane-surface") ?? "",
    x: Math.round(card.getBoundingClientRect().x),
    y: Math.round(card.getBoundingClientRect().y),
  })));
  return new Map(raw.map((entry) => [entry.id, entry]));
}

async function waitForDesktopViewToMatchSurface(): Promise<void> {
  let latest: { surface?: PaneBounds; view?: PaneBounds } = {};
  try {
    await pollUntil(async () => {
      const surface = await chrome.locator('[data-pane-surface="desktop-1440"]').boundingBox();
      const view = await application.evaluate(async ({ BrowserWindow, WebContentsView }, input) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (!window) return undefined;
        for (const child of window.contentView.children) {
          if (!(child instanceof WebContentsView) || !child.webContents.getURL().startsWith(input.origin)) continue;
          const width = await child.webContents.executeJavaScript("innerWidth").catch(() => -1);
          if (width === input.viewportWidth) return child.getBounds();
        }
        return undefined;
      }, { origin: fixtureOrigin(FIXTURE_PORT), viewportWidth: 1440 });
      latest = { ...(surface ? { surface } : {}), ...(view ? { view } : {}) };
      if (!surface || !view) return null;
      return ["x", "y", "width", "height"].every((key) =>
        Math.abs(surface[key as keyof PaneBounds] - view[key as keyof PaneBounds]) <= 1,
      ) || null;
    }, 10_000);
  } catch (cause) {
    throw new Error(`desktop native view did not converge on its moved surface: ${JSON.stringify(latest)}`, { cause });
  }
}

it("drag and drop moves a pane and persists the position", async () => {
  fixture = await startFixtureServer(FIXTURE_PORT);
  const launched = await launchDesktopApp({ port: FIXTURE_PORT });
  application = launched.application;
  chrome = launched.chrome;
  userDataDir = launched.userDataDir;
  await waitForFixturePanes(launched.application, FIXTURE_PORT, 5, 15_000);
  await pollUntil(async () => {
    try {
      return (await cardBoxes(chrome)).size === 5 || null;
    } catch {
      return null; // reload invalidates evaluation contexts mid-poll; retry on the next tick
    }
  }, 10_000);

  const before = (await cardBoxes(chrome)).get("desktop-1440");
  if (!before) throw new Error("source card missing");
  const workspaceFile = join(userDataDir, "user-data", "workspace.json");

  // Synthetic drag: verifies wiring without trusted input.
  await chrome.evaluate(() => {
    const surface = document.querySelector('[data-pane-surface="desktop-1440"]');
    const card = surface?.parentElement;
    const headerElement = card?.querySelector("header");
    if (!surface || !card || !headerElement) return;
    const rect = headerElement.getBoundingClientRect();
    headerElement.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: rect.x + 30, clientY: rect.y + 10 }));
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: rect.x + 150, clientY: rect.y + 60 }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
  const afterSynthetic = await pollUntil(async () => {
    const boxes = await cardBoxes(chrome);
    const current = boxes.get("desktop-1440");
    return current && current.x !== before.x ? current : null;
  }, 8_000);
  // The synthetic move updates renderer geometry first. On slower Windows runners the old
  // WebContentsView can still cover the header's new position and steal a trusted pointerdown.
  // Wait for Electron's authoritative native bounds, not a timing delay, before native input.
  await waitForDesktopViewToMatchSurface();

  // Native-pointer drag of the desktop pane header toward the top-left.
  const header = chrome.locator('[data-pane-surface="desktop-1440"]').locator("xpath=..").locator("header");
  const headerBox = await header.boundingBox();
  if (!headerBox) throw new Error("header box missing");
  // Resolve a point through the renderer's own hit testing. Fixed offsets can land on the
  // article border under Windows scaling, while midpoint guesses can hit toolbar controls.
  const start = await header.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const y = Math.floor(rect.y + rect.height / 2);
    for (let x = Math.ceil(rect.x) + 1; x < Math.floor(rect.right); x += 1) {
      const target = document.elementFromPoint(x, y) as HTMLElement | null;
      if (target?.closest("[data-pane-header]") === element && !target.closest("button, input, select, [data-pane-name]")) return { x, y };
    }
    return null;
  });
  if (!start) throw new Error(`no draggable header background found in ${JSON.stringify(headerBox)}`);
  const startX = start.x;
  const startY = start.y;
  await chrome.mouse.move(startX, startY);
  await chrome.mouse.down();
  for (const step of [0.2, 0.4, 0.6, 0.8, 1]) {
    // Synthetic setup already moved the card down/right, so an up/left native drag has
    // guaranteed room on every runner display and cannot be masked by viewport clamping.
    await chrome.mouse.move(startX - 80 * step, startY - 40 * step);
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 40));
  }
  await chrome.mouse.up();

  // From here on, ANY failure (flush/move pollUntils, relaunch, either axis) must preserve
  // on-disk evidence before afterAll wipes userDataDir — not just an x-axis mismatch.
  try {
    // Persistence proof: the dragged card must have reached a clearly moved position AND the
    // workspace store must hold a stable entry for it. Stored coordinates live in the
    // workspace-content space (renderer rect minus fixed chrome offset), so only stability and
    // x-axis agreement are checked here — never cross-space y equality.
    let stored: { x: number; y: number } | undefined;
    const moved = await pollUntil(async () => {
      const current = await cardBoxes(chrome).then((boxes) => boxes.get("desktop-1440")).catch(() => undefined);
      if (!current || (Math.abs(current.x - afterSynthetic.x) < 40 && Math.abs(current.y - afterSynthetic.y) < 20)) return null;
      const position = await readFile(workspaceFile, "utf8").then((raw) => JSON.parse(raw)?.positions?.["desktop-1440"]).catch(() => null);
      if (!position || Math.abs(position.x - current.x) > 1) return null;
      if (!stored || stored.x !== position.x || stored.y !== position.y) {
        stored = position;
        return null; // require the same value twice in a row so the async writer has settled
      }
      return current;
    }, 15_000);

    // Position persists across an app restart (workspace store).
    await application.close();
    const relaunched = await launchDesktopApp({ port: FIXTURE_PORT, userDataDir });
    application = relaunched.application;
    chrome = relaunched.chrome;
    userDataDir = relaunched.userDataDir;
    await pollUntil(async () => {
      try {
        return (await cardBoxes(chrome)).size === 5 || null;
      } catch {
        return null; // reload invalidates evaluation contexts mid-poll; retry on the next tick
      }
    }, 15_000);
    // The relaunched renderer's first layout can race the application of persisted positions
    // (known seed-render race), so converge on the pre-close visual coordinates: a 10 s grace
    // phase, then exactly one forced reload to reapply them, then a second bounded phase.
    const matches = async (): Promise<CardBox | null> => {
      try {
        const current = (await cardBoxes(chrome)).get("desktop-1440");
        if (current && Math.abs(current.x - moved.x) <= 3 && Math.abs(current.y - moved.y) <= 3) return current;
      } catch {
        // A navigation invalidates evaluation contexts mid-poll; let the next tick retry.
      }
      return null;
    };
    try {
      await pollUntil(matches, 10_000);
    } catch {
      await chrome.evaluate(() => location.reload()).catch(() => undefined);
      try {
        await pollUntil(matches, 15_000);
      } catch (cause) {
        throw new Error(`renderer never restored the dragged desktop-1440 position moved=${JSON.stringify(moved)} even after one forced reload`, { cause });
      }
    }
  } catch (error) {
    // Close Chromium before collecting evidence: Windows otherwise locks profile databases
    // and a diagnostic copy failure masks the actual drag assertion.
    await application.close().catch(() => undefined);
    // A fresh mkdtemp target needs no rmSync and can never clobber real evidence.
    const dumpDir = await mkdtemp(join(tmpdir(), "dnd-fail-dump-"));
    try {
      cpSync(workspaceFile, join(dumpDir, "workspace.json"));
    } catch (copyError) {
      console.log(`DND FAIL DUMP copy failed at ${dumpDir}:`, copyError);
    }
    const fileOnDisk = await readFile(workspaceFile, "utf8").catch(() => "MISSING");
    console.log(`DND FAIL DUMP copied to ${dumpDir}; workspace.json:`, fileOnDisk.slice(0, 600));
    throw error;
  }
}, 60_000);
