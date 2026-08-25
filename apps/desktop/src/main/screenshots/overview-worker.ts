import { parentPort, workerData } from "node:worker_threads";
import sharp, { type OverlayOptions } from "sharp";
import { errorMessage } from "@hoolypane/contracts";
import type { OverviewInput, OverviewWorkerResponse } from "./overview-protocol.js";
import { OVERVIEW_ERROR_TILE_COLOR } from "./overview-shared.js";


function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character] ?? character);
}

async function render(input: OverviewInput): Promise<Buffer> {
  const metadata = await Promise.all(input.tiles.map(async (tile) => tile.png ? sharp(tile.png).metadata() : undefined));
  const tileWidth = Math.min(1600, Math.max(480, ...metadata.map((value) => value?.width ?? 480)));
  const imageHeight = Math.min(1200, Math.max(320, ...metadata.map((value) => value?.height ?? 320)));
  const headerHeight = 56;
  const tileHeight = imageHeight + headerHeight;
  const columns = Math.ceil(Math.sqrt(input.tiles.length));
  const rows = Math.ceil(input.tiles.length / columns);
  const overlays: OverlayOptions[] = [];
  for (const [index, tile] of input.tiles.entries()) {
    const left = index % columns * tileWidth;
    const top = Math.floor(index / columns) * tileHeight;
    const header = Buffer.from(`<svg width="${tileWidth}" height="${headerHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#1b1f26"/><text x="16" y="24" fill="#f4f6f8" font-family="sans-serif" font-size="16" font-weight="600">${escapeXml(tile.name)}</text><text x="16" y="44" fill="#aeb7c2" font-family="sans-serif" font-size="13">${escapeXml(tile.dimensions)}</text></svg>`);
    overlays.push({ input: header, left, top });
    if (tile.png) {
      const image = await sharp(tile.png).resize(tileWidth, imageHeight, { fit: "contain", background: input.background }).png().toBuffer();
      overlays.push({ input: image, left, top: top + headerHeight });
    } else {
      const error = Buffer.from(`<svg width="${tileWidth}" height="${imageHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="${OVERVIEW_ERROR_TILE_COLOR}"/><text x="24" y="48" fill="#ffb4b8" font-family="sans-serif" font-size="16">Capture failed</text><text x="24" y="78" fill="#ffd9dc" font-family="sans-serif" font-size="13">${escapeXml(tile.error ?? "unknown error")}</text></svg>`);
      overlays.push({ input: error, left, top: top + headerHeight });
    }
  }
  return sharp({ create: { width: columns * tileWidth, height: rows * tileHeight, channels: 4, background: input.background } }).composite(overlays).png().toBuffer();
}

void render(workerData as OverviewInput).then(
  (png) => parentPort?.postMessage({ ok: true, png } satisfies OverviewWorkerResponse),
  (error: unknown) => parentPort?.postMessage({ ok: false, error: errorMessage(error) } satisfies OverviewWorkerResponse),
);
