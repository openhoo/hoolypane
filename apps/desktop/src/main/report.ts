export function report(paneId: string, message: string): void {
  console.error(`[hoolypane] ${paneId === "" ? "main" : `pane ${paneId}`}: ${message}`);
}
