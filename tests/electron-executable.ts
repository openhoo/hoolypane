import { resolve } from "node:path";
import { REPO_ROOT } from "./helpers/desktop-runtime.js";

export function electronExecutablePath(): string {
  const executable = process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron";
  return resolve(REPO_ROOT, "apps/desktop/node_modules/electron/dist", executable);
}
