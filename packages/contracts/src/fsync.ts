import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

/** Best-effort fsync of the parent directory so a completed rename survives power loss. */
async function syncParentDirectory(path: string): Promise<void> {
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

export const ARTIFACT_MODE = 0o600;
/** Suffix of writeFileAtomic's crash-safe temporary; sweep helpers must match via
 *  hasAtomicTempSuffix instead of re-encoding this literal by hand. */
export const ARTIFACT_TEMP_SUFFIX = ".tmp";

/** Writes `data` durably via a unique same-directory temporary: wx-open (private-artifact 0o600)
 *  -> write -> content fsync -> rename -> unlink temp on failure -> parent-dir fsync.
 *  Single source for recorder spool artifacts and desktop persistence; import via this
 *  "@hoolypane/contracts/fsync" subpath, never the browser-facing barrel. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}${ARTIFACT_TEMP_SUFFIX}`;
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

/** True when a directory entry is a writeFileAtomic temporary left behind by an interrupted save. */
export function hasAtomicTempSuffix(name: string): boolean {
  return name.endsWith(ARTIFACT_TEMP_SUFFIX);
}
