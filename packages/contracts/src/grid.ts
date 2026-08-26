/**
 * Single source for the square-root tile-grid arrangement shared by the recorder's composite video
 * (filterGraph's xstack layout) and the desktop overview PNG renderer: both artifact families must
 * place track N in the same cell or the PNG and the video silently diverge. Pure integer math so
 * every consumer can depend on this platform-neutral module.
 */

/** Row-major sqrt grid: ceil(sqrt(count)) columns cover `count` tiles roughly square, rows take
 *  the remainder; consecutive indices fill each row left-to-right before wrapping downward. */
export function gridDimensions(count: number): { columns: number; rows: number } {
  const columns = Math.ceil(Math.sqrt(count));
  return { columns, rows: Math.ceil(count / columns) };
}

/** Pixel offset of tile `index` in that grid; mirrors the historical `(index % columns) * tileWidth` precedence. */
export function gridCellPosition(index: number, columns: number, tileWidth: number, tileHeight: number): { left: number; top: number } {
  return { left: (index % columns) * tileWidth, top: Math.floor(index / columns) * tileHeight };
}
