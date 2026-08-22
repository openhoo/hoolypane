import { contextBridge, ipcRenderer } from "electron";
import { BoundsSnapshotSchema, ChromeCommandSchema, type BoundsSnapshot, type ChromeCommand, IPC_CHANNELS } from "@hoolypane/contracts";

const send = (command: ChromeCommand): void => {
  const parsed = ChromeCommandSchema.safeParse(command);
  if (!parsed.success) { console.error("[hoolypane] rejected chrome command", parsed.error.message); return; }
  ipcRenderer.send(IPC_CHANNELS.command, parsed.data);
};
const sendBounds = (bounds: BoundsSnapshot): void => {
  const parsed = BoundsSnapshotSchema.safeParse(bounds);
  if (!parsed.success) { console.error("[hoolypane] rejected bounds snapshot", parsed.error.message); return; }
  ipcRenderer.send(IPC_CHANNELS.bounds, parsed.data);
};
const subscribe = (callback: (state: unknown) => void): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
  ipcRenderer.on(IPC_CHANNELS.state, listener);
  // Pull handshake: a state push that fired before this subscription existed would otherwise leave
  // the renderer on its initial snapshot until some unrelated change triggered the next push.
  ipcRenderer.send(IPC_CHANNELS.stateRequest);
  return () => ipcRenderer.removeListener(IPC_CHANNELS.state, listener);
};
contextBridge.exposeInMainWorld("hoolypaneChrome", Object.freeze({ send, sendBounds, subscribe }));

declare global { interface Window { hoolypaneChrome: { send(command: ChromeCommand): void; sendBounds(bounds: BoundsSnapshot): void; subscribe(callback: (state: unknown) => void): () => void } } }
