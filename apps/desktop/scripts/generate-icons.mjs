import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const build = join(root, "build");
const svg = await fs.readFile(join(build, "icon.svg"));
const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];
const images = new Map();
await fs.mkdir(join(build, "icons"), { recursive: true });
for (const size of sizes) {
  const png = await sharp(svg).resize(size, size).png().toBuffer();
  images.set(size, png);
  await fs.writeFile(join(build, "icons", `${size}x${size}.png`), png);
}

const icoSizes = [16, 32, 48, 64, 128, 256];
const icoHeader = Buffer.alloc(6 + icoSizes.length * 16);
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(icoSizes.length, 4);
let icoOffset = icoHeader.length;
const icoParts = [icoHeader];
icoSizes.forEach((size, index) => {
  const png = images.get(size);
  const entry = 6 + index * 16;
  icoHeader.writeUInt8(size === 256 ? 0 : size, entry);
  icoHeader.writeUInt8(size === 256 ? 0 : size, entry + 1);
  icoHeader.writeUInt8(0, entry + 2);
  icoHeader.writeUInt8(0, entry + 3);
  icoHeader.writeUInt16LE(1, entry + 4);
  icoHeader.writeUInt16LE(32, entry + 6);
  icoHeader.writeUInt32LE(png.length, entry + 8);
  icoHeader.writeUInt32LE(icoOffset, entry + 12);
  icoOffset += png.length;
  icoParts.push(png);
});
await fs.writeFile(join(build, "icon.ico"), Buffer.concat(icoParts));

const icnsTypes = new Map([[128, "ic07"], [256, "ic08"], [512, "ic09"], [1024, "ic10"]]);
const icnsChunks = [];
for (const [size, type] of icnsTypes) {
  const png = images.get(size);
  const chunk = Buffer.alloc(8);
  chunk.write(type, 0, 4, "ascii");
  chunk.writeUInt32BE(png.length + 8, 4);
  icnsChunks.push(chunk, png);
}
const icnsHeader = Buffer.alloc(8);
icnsHeader.write("icns", 0, 4, "ascii");
icnsHeader.writeUInt32BE(8 + icnsChunks.reduce((total, chunk) => total + chunk.length, 0), 4);
await fs.writeFile(join(build, "icon.icns"), Buffer.concat([icnsHeader, ...icnsChunks]));
