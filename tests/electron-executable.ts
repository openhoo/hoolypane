import { resolve } from "node:path";

export function electronExecutablePath(): string {
  const executable = process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron";
  return resolve("apps/desktop/node_modules/electron/dist", executable);
}
