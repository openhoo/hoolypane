import { contextBridge, ipcRenderer } from "electron";
import { BoundsSnapshotSchema, ChromeCommandSchema, type BoundsSnapshot, type ChromeCommand, IPC_CHANNELS } from "@hoolypane/contracts";

interface HoolypaneChromeBridge {
  send(command: ChromeCommand): void;
  sendBounds(bounds: BoundsSnapshot): void;
  subscribe(callback: (state: unknown) => void): () => void;
}

// One safeParse→log→drop guard shared by all outbound messages: a payload violating its schema
// is dropped locally instead of crossing the IPC boundary.
function validatedSend<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { message: string } } }, channel: string, label: string, payload: T): void {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) { console.error(`[hoolypane] rejected ${label}`, parsed.error.message); return; }
  ipcRenderer.send(channel, parsed.data);
}
const send = (command: ChromeCommand): void => validatedSend(ChromeCommandSchema, IPC_CHANNELS.command, "chrome command", command);
const sendBounds = (bounds: BoundsSnapshot): void => validatedSend(BoundsSnapshotSchema, IPC_CHANNELS.bounds, "bounds snapshot", bounds);
const subscribe = (callback: (state: unknown) => void): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
  ipcRenderer.on(IPC_CHANNELS.state, listener);
  // Pull handshake: a state push that fired before this subscription existed would otherwise leave
  // the renderer on its initial snapshot until some unrelated change triggered the next push.
  ipcRenderer.send(IPC_CHANNELS.stateRequest);
  return () => ipcRenderer.removeListener(IPC_CHANNELS.state, listener);
};
contextBridge.exposeInMainWorld("hoolypaneChrome", Object.freeze({ send, sendBounds, subscribe }) satisfies HoolypaneChromeBridge);

declare global { interface Window { hoolypaneChrome: HoolypaneChromeBridge } }
