import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import sharp from "sharp";
import {
  LINUX_SOFTWARE_RENDERING_ARGS,
  REPO_ROOT,
  applyLinuxSoftwareRenderingEnv,
  startFixtureServer,
} from "../tests/helpers/desktop-runtime.ts";
import { FIXTURE_PORTS, fixtureOrigin } from "../tests/fixtures/ports.ts";

const OUTPUT_DIR = resolve(REPO_ROOT, "docs/screenshots");
const WINDOW_SIZE = { width: 1600, height: 1000 };
const FIXTURE_PORT = FIXTURE_PORTS.readmeScreenshots;

function electronExecutablePath() {
  const executable = process.platform === "darwin"
    ? "Electron.app/Contents/MacOS/Electron"
    : process.platform === "win32"
      ? "electron.exe"
      : "electron";
  return resolve(REPO_ROOT, "apps/desktop/node_modules/electron/dist", executable);
}

async function pollUntil(action, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await action();
    if (value !== null && value !== undefined && value !== false) return value;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
  throw new Error(`README screenshot readiness timed out after ${timeoutMs}ms`);
}

async function waitForLayout(chrome, layout, expectedVisiblePanes) {
  await chrome.locator("#layout").selectOption(layout);
  await chrome.getByText(`5 panes · ${layout}`, { exact: true }).waitFor();
  await pollUntil(async () => {
    const visible = await chrome.locator("[data-pane-surface]:visible").count();
    return visible === expectedVisiblePanes;
  });
  // Bounds emission and native view placement settle over two animation frames.
  await chrome.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
}

async function scrollDemoPagesToHero(application) {
  const origin = fixtureOrigin(FIXTURE_PORT);
  const panes = application.context().pages().filter((page) => page.url().startsWith(origin));
  await Promise.all(panes.map(async (page) => {
    await page.waitForLoadState("domcontentloaded");
    await page.locator("header.hero").evaluate((element) => element.scrollIntoView({ block: "start" }));
    await page.evaluate(() => document.fonts.ready);
  }));
}

async function captureComposite(application, chrome) {
  await chrome.bringToFront();
  await chrome.mouse.move(0, 0);
  const shell = await chrome.screenshot({ animations: "disabled", caret: "hide", scale: "css" });
  const shellMetadata = await sharp(shell).metadata();
  const shellWidth = shellMetadata.width ?? WINDOW_SIZE.width;
  const shellHeight = shellMetadata.height ?? WINDOW_SIZE.height;
  const geometry = await chrome.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    surfaces: Array.from(document.querySelectorAll("[data-pane-surface]"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          id: element.getAttribute("data-pane-surface") ?? "",
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          visible: rect.width > 1 && rect.height > 1,
        };
      })
      .filter((surface) => surface.id && surface.visible),
  }));
  const scaleX = shellWidth / geometry.width;
  const scaleY = shellHeight / geometry.height;
  const origin = fixtureOrigin(FIXTURE_PORT);
  const panes = application.context().pages().filter((page) => page.url().startsWith(origin));
  const paneWidths = await Promise.all(panes.map(async (page) => ({ page, width: await page.evaluate(() => window.innerWidth) })));
  const overlays = [];
  for (const surface of geometry.surfaces) {
    const expectedWidth = Number(surface.id.match(/-(\d+)$/)?.[1]);
    const pane = paneWidths.find((entry) => entry.width === expectedWidth)?.page;
    if (!pane) throw new Error(`could not match ${surface.id} to a fixture pane`);
    const screenshot = await pane.screenshot({ animations: "disabled", caret: "hide" });
    const width = Math.max(1, Math.round(surface.width * scaleX));
    const height = Math.max(1, Math.round(surface.height * scaleY));
    overlays.push({
      input: await sharp(screenshot).resize(width, height, { fit: "fill" }).png().toBuffer(),
      left: Math.round(surface.x * scaleX),
      top: Math.round(surface.y * scaleY),
    });
  }
  return sharp(shell)
    .composite(overlays)
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

async function writeStableScreenshot(application, chrome, name) {
  let previous;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await captureComposite(application, chrome);
    if (previous && createHash("sha256").update(previous).digest("hex") === createHash("sha256").update(current).digest("hex")) {
      const path = join(OUTPUT_DIR, name);
      await sharp(current).toFile(path);
      console.log(`README_SCREENSHOT_OK ${path}`);
      return;
    }
    previous = current;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }
  throw new Error(`${name} did not reach two identical consecutive captures`);
}

let application;
let fixture;
let profileDir = "";
try {
  await mkdir(OUTPUT_DIR, { recursive: true });
  fixture = await startFixtureServer(FIXTURE_PORT);
  profileDir = await mkdtemp(join(tmpdir(), "hoolypane-readme-"));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("HOOLYPANE_")),
  );
  if (process.platform === "linux") {
    Object.assign(environment, applyLinuxSoftwareRenderingEnv(environment), { XDG_SESSION_TYPE: "x11" });
    delete environment.WAYLAND_DISPLAY;
  }
  application = await electron.launch({
    executablePath: electronExecutablePath(),
    args: [
      ...(process.platform === "linux" ? LINUX_SOFTWARE_RENDERING_ARGS : []),
      resolve(REPO_ROOT, "apps/desktop"),
      `--user-data-dir=${join(profileDir, "user-data")}`,
      "--url",
      fixtureOrigin(FIXTURE_PORT),
    ],
    env: environment,
  });
  const chrome = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.setSize(size.width, size.height);
    window?.center();
  }, WINDOW_SIZE);
  await pollUntil(async () => {
    const origin = fixtureOrigin(FIXTURE_PORT);
    const paneCount = await application.evaluate(({ webContents }, expectedOrigin) =>
      webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith(expectedOrigin)).length,
    origin);
    return paneCount === 5;
  });
  await scrollDemoPagesToHero(application);

  await waitForLayout(chrome, "grid", 5);
  await writeStableScreenshot(application, chrome, "hoolypane-grid.png");

  await chrome.getByRole("button", { name: "Focus" }).first().click();
  await waitForLayout(chrome, "focus", 1);
  await writeStableScreenshot(application, chrome, "hoolypane-focus.png");
} finally {
  await application?.close().catch(() => undefined);
  await fixture?.close();
  if (profileDir) await rm(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
