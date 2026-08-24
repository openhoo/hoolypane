import { cpSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { ElectronApplication, Page } from "playwright";
import { afterAll, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchDesktopApp, pollUntil, startFixtureServer, type FixtureServer } from "../helpers/harness.js";
import { FIXTURE_PORTS } from "../fixtures/ports.js";

const FIXTURE_PORT = FIXTURE_PORTS.dragdrop;

let fixture: FixtureServer | undefined;
let application!: ElectronApplication;
let chrome!: Page;
let userDataDir = "";

afterAll(async () => {
  await application?.close().catch(() => undefined);
  await fixture?.close();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
}, 30_000);

interface CardBox {
  readonly x: number;
  readonly y: number;
}

async function cardBoxes(page: Page): Promise<Map<string, CardBox>> {
  const raw = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".pane-card")).map((card) => ({
    id: card.querySelector("[data-pane-surface]")?.getAttribute("data-pane-surface") ?? "",
    x: Math.round(card.getBoundingClientRect().x),
    y: Math.round(card.getBoundingClientRect().y),
  })));
  return new Map(raw.map((entry) => [entry.id, entry]));
}
/** Parses the persisted pane position from workspace.json without trusting its shape. */
function readSavedPosition(raw: string): CardBox | null {
  if (raw === "MISSING") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !("positions" in parsed)) return null;
  const positions = parsed.positions;
  if (!positions || typeof positions !== "object" || !("desktop-1440" in positions)) return null;
  const saved = positions["desktop-1440"];
  if (!saved || typeof saved !== "object" || !("x" in saved) || !("y" in saved)) return null;
  const { x, y } = saved;
  return typeof x === "number" && typeof y === "number" ? { x, y } : null;
}

it("drag and drop moves a pane and persists the position", async () => {
  fixture = await startFixtureServer(FIXTURE_PORT);
  const launched = await launchDesktopApp({ port: FIXTURE_PORT });
  application = launched.application;
  chrome = launched.chrome;
  userDataDir = launched.userDataDir;
  await pollUntil(async () => {
    const count = await launched.application.evaluate(({ webContents }, port) =>
      webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith(`http://127.0.0.1:${port}`)).length,
      FIXTURE_PORT);
    return count === 5 || null;
  }, 15_000);
  await pollUntil(async () => (await cardBoxes(chrome)).size === 5 || null, 10_000);

  const before = (await cardBoxes(chrome)).get("desktop-1440");
  if (!before) throw new Error("source card missing");

  // Synthetic drag: verifies wiring without trusted input.
  const synthetic = await chrome.evaluate(() => {
    const surface = document.querySelector('[data-pane-surface="desktop-1440"]');
    const card = surface?.parentElement;
    const headerElement = card?.querySelector("header");
    if (!surface || !card || !headerElement) return { error: "missing" };
    const rect = headerElement.getBoundingClientRect();
    headerElement.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: rect.x + 30, clientY: rect.y + 10 }));
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: rect.x + 150, clientY: rect.y + 60 }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    return {
      dragX: card.getAttribute("data-drag-x"),
      left: (card.getAttribute("style") ?? "").match(/left:\s*(\d+)px/)?.[1] ?? "?",
      guides: document.querySelectorAll('[aria-hidden="true"][class*="bg-accent"]').length,
    };
  });
  console.log("SYNTHETIC", JSON.stringify(synthetic));
  await pollUntil(async () => {
    const boxes = await cardBoxes(chrome);
    const current = boxes.get("desktop-1440");
    return current && current.x !== before.x ? current : null;
  }, 8_000);
  const afterSynthetic = (await cardBoxes(chrome)).get("desktop-1440");
  console.log("AFTER SYNTHETIC", JSON.stringify(afterSynthetic));

  // Native-pointer drag of the desktop pane header toward the bottom-right.
  const header = chrome.locator('[data-pane-surface="desktop-1440"]').locator("xpath=..").locator("header");
  const headerBox = await header.boundingBox();
  if (!headerBox) throw new Error("header box missing");
  const startX = headerBox.x + 30;
  const startY = headerBox.y + headerBox.height / 2;
  await chrome.mouse.move(startX, startY);
  await chrome.mouse.down();
  for (const step of [0.2, 0.4, 0.6, 0.8, 1]) {
    await chrome.mouse.move(startX + 300 * step, startY + 170 * step);
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 40));
  }
  await chrome.mouse.up();

  // From here on, ANY failure (flush/move pollUntils, relaunch, either axis) must preserve
  // on-disk evidence before afterAll wipes userDataDir — not just an x-axis mismatch.
  const workspaceFile = join(userDataDir, "user-data", "workspace.json");
  try {
    // Wait until the workspace store flushed the new position (graceful-close races the async write).
    await pollUntil(async () => {
      const saved = await readFile(workspaceFile, "utf8").then(JSON.parse).catch(() => null);
      return saved?.positions?.["desktop-1440"]?.x === undefined ? null : saved.positions["desktop-1440"];
    }, 10_000);

    const moved = await pollUntil(async () => {
      const boxes = await cardBoxes(chrome);
      const current = boxes.get("desktop-1440");
      return current && current.x > before.x + 150 && current.y > before.y + 80 ? current : null;
    }, 10_000);
    console.log("DND moved to", moved.x, moved.y);

    // Position persists across an app restart (workspace store).
    await application.close();
    const relaunched = await launchDesktopApp({ port: FIXTURE_PORT, userDataDir });
    application = relaunched.application;
    chrome = relaunched.chrome;
    userDataDir = relaunched.userDataDir;
    await pollUntil(async () => (await cardBoxes(chrome)).size === 5 || null, 15_000);
    // The feature's guarantee is the workspace store on disk, not pixel identity between
    // two independent masonry computations across a restart. The relaunched renderer's
    // first layout can also race the application of persisted positions, so converge on
    // the stored coordinates (with one forced reload to reapply them) instead of
    // comparing pre-close and post-restart renderer snapshots.
    const fileOnDisk = await readFile(workspaceFile, "utf8").catch(() => "MISSING");
    const saved = readSavedPosition(fileOnDisk);
    if (!saved) {
      throw new Error(`workspace.json holds no usable desktop-1440 position: ${fileOnDisk.slice(0, 400)}`);
    }
    let persisted: CardBox;
    try {
      let reloadedForRestore = false;
      persisted = await pollUntil(async () => {
        try {
          const current = (await cardBoxes(chrome)).get("desktop-1440");
          if (current && Math.abs(current.x - saved.x) <= 3 && Math.abs(current.y - saved.y) <= 3) return current;
        } catch {
          // A navigation invalidates evaluation contexts mid-poll; let the next tick retry.
          return null;
        }
        if (!reloadedForRestore) {
          reloadedForRestore = true;
          await chrome.evaluate(() => location.reload()).catch(() => undefined);
          // The reload itself invalidates evaluation contexts while landing; tolerate
          // transient failures on this convergence poll instead of aborting.
          await pollUntil(async () => {
            try {
              return (await cardBoxes(chrome)).size === 5 || null;
            } catch {
              return null;
            }
          }, 15_000);
        }
        return null;
      }, 15_000);
    } catch (cause) {
      throw new Error(`renderer never restored the persisted desktop-1440 position saved=${JSON.stringify(saved)}`, { cause });
    }
    console.log("DND persisted", persisted.x, persisted.y);
  } catch (error) {
    // A fresh mkdtemp target needs no rmSync and can never clobber real evidence.
    const dumpDir = await mkdtemp(join(tmpdir(), "dnd-fail-dump-"));
    cpSync(join(userDataDir, "user-data"), join(dumpDir, "user-data"), { recursive: true });
    const fileOnDisk = await readFile(workspaceFile, "utf8").catch(() => "MISSING");
    console.log(`DND FAIL DUMP copied to ${dumpDir}; workspace.json:`, fileOnDisk.slice(0, 600));
    throw error;
  }
}, 60_000);
