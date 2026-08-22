import { rm } from "node:fs/promises";
import { afterAll, expect, it } from "vitest";
import { launchDesktopApp, pollUntil, startFixtureServer, type FixtureServer } from "../helpers/harness.js";

const FIXTURE_PORT = 4196;

let fixture: FixtureServer | undefined;
let application: ElectronApplication | undefined;
let userDataDir = "";

afterAll(async () => {
  await application?.close().catch(() => undefined);
  await fixture?.close();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
}, 30_000);

it("probe wheel scroll on scroller", async () => {
  fixture = await startFixtureServer(FIXTURE_PORT);
  const launched = await launchDesktopApp({ port: FIXTURE_PORT });
  application = launched.application;
  userDataDir = launched.userDataDir;
  await pollUntil(async () => {
    const count = await launched.application.evaluate(({ webContents }, port) =>
      webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith(`http://127.0.0.1:${port}`)).length,
      FIXTURE_PORT);
    return count === 5 || null;
  }, 15_000);
  const surface = await launched.chrome.locator('[data-pane-surface="desktop-1440"]').boundingBox();
  if (!surface) throw new Error("surface missing");
  const scale = Math.min(1, surface.width / 1440, surface.height / 900);
  const result = await launched.application.evaluate(async ({ webContents }, input) => {
    const candidates = webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith(`http://127.0.0.1:${input.port}`));
    let source: (typeof candidates)[number] | undefined;
    for (const candidate of candidates) {
      if (await candidate.executeJavaScript("innerWidth") === 1440) { source = candidate; break; }
    }
    if (!source) throw new Error("source missing");
    const before = await source.executeJavaScript(`(() => {
      const element = document.querySelector('[data-testid="scroller"]');
      element.scrollIntoView({ block: "center", inline: "center" });
      const box = element.getBoundingClientRect().toJSON();
      return { box, top: element.scrollTop, max: element.scrollHeight - element.clientHeight };
    })()`);
    await source.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseWheel", x: (before.box.x + before.box.width / 2) * input.scale, y: (before.box.y + before.box.height / 2) * input.scale, deltaX: 0, deltaY: 1000 });
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 400));
    const after = await source.executeJavaScript(`(() => {
      const element = document.querySelector('[data-testid="scroller"]');
      return { top: element.scrollTop, max: element.scrollHeight - element.clientHeight, docScroll: Math.round(document.scrollingElement.scrollTop), elementAtPoint: (() => { const elementAtPoint = document.elementFromPoint(innerWidth / 2, innerHeight / 2); return elementAtPoint ? elementAtPoint.tagName + "." + (elementAtPoint.getAttribute("data-testid") ?? "") : "none"; })() };
    })()`);
    return { scale: input.scale, before, after };
  }, { port: FIXTURE_PORT, scale });
  console.log("SCROLL PROBE", JSON.stringify(result));
  expect(true).toBe(true);
}, 60_000);
