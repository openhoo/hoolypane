import { readFile, rm } from "node:fs/promises";
import type { ElectronApplication, Page } from "playwright";
import { afterAll, expect, it } from "vitest";
import { join } from "node:path";
import { launchDesktopApp, pollUntil, startFixtureServer, type FixtureServer } from "../helpers/harness.js";

const FIXTURE_PORT = 4186;

let fixture: FixtureServer | undefined;
let application: ElectronApplication | undefined;
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

it("drag and drop moves a pane and persists the position", async () => {
  fixture = await startFixtureServer(FIXTURE_PORT);
  const launched = await launchDesktopApp({ port: FIXTURE_PORT });
  application = launched.application;
  userDataDir = launched.userDataDir;
  const chrome = launched.chrome;
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

  // Wait until the workspace store flushed the new position (graceful-close races the async write).
  const workspaceFile = join(userDataDir, "user-data", "workspace.json");
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
  userDataDir = relaunched.userDataDir;
  await pollUntil(async () => (await cardBoxes(relaunched.chrome)).size === 5 || null, 15_000);
  const persisted = (await cardBoxes(relaunched.chrome)).get("desktop-1440");
  if (!persisted) throw new Error("persisted card missing");
  expect(Math.abs(persisted.x - moved.x)).toBeLessThanOrEqual(3);
  expect(Math.abs(persisted.y - moved.y)).toBeLessThanOrEqual(3);
  console.log("DND persisted", persisted.x, persisted.y);
}, 60_000);
