import { promises as fs } from "node:fs";
import { dirname } from "node:path";

/** Best-effort fsync of the parent directory so a completed rename survives power loss. */
export async function syncParentDirectory(path: string): Promise<void> {
  try {
    const handle = await fs.open(dirname(path), "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    /* directory fsync is unsupported on some platforms */
  }
}
