import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function electronExecutablePath(): string {
  const executable = process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron";
  return resolve(REPO_ROOT, "apps/desktop/node_modules/electron/dist", executable);
}
