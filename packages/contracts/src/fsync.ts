import { randomBytes } from "node:crypto";
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

const ARTIFACT_MODE = 0o600;

/** Writes `data` durably via a unique same-directory temporary: wx-open (private-artifact 0o600)
 *  -> write -> content fsync -> rename -> unlink temp on failure -> parent-dir fsync. The
 *  Single source for recorder spool artifacts and desktop persistence; import via this
 *  "@hoolypane/contracts/fsync" subpath, never the browser-facing barrel. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await fs.open(temporary, "wx", ARTIFACT_MODE);
  try {
    await handle.writeFile(data);
    await handle.sync();
    await fs.rename(temporary, path);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
  await syncParentDirectory(path);
}
