import { it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { launchDesktopApp, startFixtureServer } from "../helpers/harness.js";
import { FIXTURE_PORTS } from "../fixtures/ports.js";

it("probe close", async () => {
  const fixture = await startFixtureServer(FIXTURE_PORTS.dragdrop);
  const userDataDir = await mkdtemp(`${tmpdir()}/hoolypane-close-probe-`);
  console.log("launching");
  const launched = await launchDesktopApp({ port: FIXTURE_PORTS.dragdrop, userDataDir });
  console.log("launched; waiting 2s");
  await new Promise((r) => setTimeout(r, 2000));
  // Synthetic drag on first instance (mirrors the failing E2E prelude)
  await launched.chrome.evaluate(() => {
    const card = Array.from(document.querySelectorAll(".pane-card")).find((c) => c.querySelector('[data-pane-surface="desktop-1440"]'));
    const header = card?.querySelector("header");
    const rect = header.getBoundingClientRect();
    header.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: rect.x + 30, clientY: rect.y + 10 }));
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: rect.x + 150, clientY: rect.y + 60 }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 500));
  // Native pointer drag like the E2E
  const header = launched.chrome.locator('[data-pane-surface="desktop-1440"]').locator("xpath=..").locator("header");
  const hb = await header.boundingBox();
  if (!hb) throw new Error("no header box");
  await launched.chrome.mouse.move(hb.x + 30, hb.y + hb.height / 2);
  await launched.chrome.mouse.down();
  for (const step of [0.25, 0.5, 0.75, 1]) {
    await launched.chrome.mouse.move(hb.x + 300 * step, hb.y + 170 * step);
    await new Promise((r) => setTimeout(r, 40));
  }
  await launched.chrome.mouse.up();
  await new Promise((r) => setTimeout(r, 500));
  console.log("closing app");
  const closeResult = await Promise.race([
    launched.application.close().then(() => "closed", (error) => `close-error: ${error?.message ?? String(error)}`),
    new Promise((r) => setTimeout(() => r("CLOSE_TIMEOUT_15S"), 15_000)),
  ]);
  console.log("close result:", closeResult);
  console.log("relaunching");
  const second = await launchDesktopApp({ port: FIXTURE_PORTS.dragdrop, userDataDir });
  console.log("relaunched; waiting 2s");
  await new Promise((r) => setTimeout(r, 2000));
  console.log("closing second app");
  const close2 = await Promise.race([
    second.application.close().then(() => "closed", (error) => `close-error: ${error?.message ?? String(error)}`),
    new Promise((r) => setTimeout(() => r("CLOSE2_TIMEOUT_15S"), 15_000)),
  ]);
  console.log("second close result:", close2);
  console.log("closing fixture");
  await fixture.close();
  console.log("fixture closed");
}, 60_000);
