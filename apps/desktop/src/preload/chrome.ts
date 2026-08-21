import { contextBridge, ipcRenderer } from "electron";
import { BoundsSnapshotSchema, ChromeCommandSchema, type BoundsSnapshot, type ChromeCommand, IPC_CHANNELS } from "@hoolypane/contracts";

const send = (command: ChromeCommand): void => { ipcRenderer.send(IPC_CHANNELS.command, ChromeCommandSchema.parse(command)); };
const sendBounds = (bounds: BoundsSnapshot): void => { ipcRenderer.send(IPC_CHANNELS.bounds, BoundsSnapshotSchema.parse(bounds)); };
const subscribe = (callback: (state: unknown) => void): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
  ipcRenderer.on(IPC_CHANNELS.state, listener);
  return () => ipcRenderer.removeListener(IPC_CHANNELS.state, listener);
};
contextBridge.exposeInMainWorld("hoolypaneChrome", Object.freeze({ send, sendBounds, subscribe }));

declare global { interface Window { hoolypaneChrome: { send(command: ChromeCommand): void; sendBounds(bounds: BoundsSnapshot): void; subscribe(callback: (state: unknown) => void): () => void } } }
