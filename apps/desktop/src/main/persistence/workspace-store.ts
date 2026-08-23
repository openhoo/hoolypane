import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { WorkspaceStateSchema, defaultWorkspace, type WorkspaceState } from "../panes/workspace.js";

const SUPPORTED_WORKSPACE_VERSION = 1;

type LoadedWorkspace = {
  state: WorkspaceState;
  /** false when the on-disk file is newer than supported or unreadable: automatic overwriting is suppressed. */
  persistable: boolean;
};

function defaults(persistable: boolean): LoadedWorkspace {
  return { state: defaultWorkspace(), persistable };
}

/** Moves an unparseable file aside so the original bytes survive before defaults take over. */
async function quarantine(file: string): Promise<boolean> {
  try {
    await fs.rename(file, `${file}.corrupt-${Date.now()}`);
    return true;
  } catch {
    return false; // could not move aside: treat as unpersistable rather than clobbering
  }
}

export async function loadWorkspace(file: string): Promise<LoadedWorkspace> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults(true);
    console.error(`[hoolypane] workspace ${file} is unreadable, continuing with defaults`, error);
    return defaults(false);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`[hoolypane] workspace ${file} is corrupt, quarantining it`, error);
    return defaults(await quarantine(file));
  }
  const version = typeof parsed === "object" && parsed !== null && "version" in parsed ? parsed.version : undefined;
  if (typeof version === "number" && version > SUPPORTED_WORKSPACE_VERSION) {
    console.error(`[hoolypane] workspace ${file} has unsupported version ${version}; leaving it untouched`);
    return defaults(false); // downgrade guard: never overwrite data written by a newer build
  }
  const result = WorkspaceStateSchema.safeParse(parsed);
  if (!result.success) {
    console.error(`[hoolypane] workspace ${file} failed validation, quarantining it`, result.error);
    return defaults(await quarantine(file));
  }
  // Sanitize instead of rejecting: position entries for panes that no longer exist are stale
  // leftovers and must not resurrect when a preset id is reused (a hard reject would quarantine
  // whole workspaces for cosmetic drift).
  const state = pruneOrphanPositions(result.data);
  return { state, persistable: true };
}

function pruneOrphanPositions(state: WorkspaceState): WorkspaceState {
  const known = new Set(state.panes.map((pane) => pane.id));
  const entries = Object.entries(state.positions).filter(([id]) => known.has(id));
  if (entries.length === Object.keys(state.positions).length) return state;
  return { ...state, positions: Object.fromEntries(entries) };
}

/** Removes crash-orphaned `*.tmp` siblings of the workspace file left behind by interrupted saves. */
export async function sweepStaleTemporaries(file: string): Promise<void> {
  const directory = join(file, "..");
  const prefix = `${basename(file)}.`;
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".tmp"))
      .map((entry) => fs.unlink(join(directory, entry)).catch(() => undefined)),
  );
}

const saveTails = new Map<string, Promise<void>>();
let temporarySequence = 0;

export async function saveWorkspace(file: string, state: WorkspaceState | (() => WorkspaceState)): Promise<void> {
  const previous = saveTails.get(file) ?? Promise.resolve();
  // A provider is evaluated when the tail executes, not when it is enqueued, so mutations
  // landing while earlier writes settle are still included.
  const task = previous.catch(() => undefined).then(() => writeWorkspace(file, typeof state === "function" ? state() : state));
  saveTails.set(
    file,
    task.then(
      () => undefined,
      () => undefined,
    ),
  );
  return task;
}

/** Resolves once every in-flight workspace write has settled; used by flush-on-quit. */
export async function flushWorkspaceSaves(): Promise<void> {
  await Promise.all([...saveTails.values()]);
}

async function writeWorkspace(file: string, state: WorkspaceState): Promise<void> {
  const directory = join(file, "..");
  const temporary = `${file}.${process.pid}.${Date.now()}-${++temporarySequence}.tmp`;
  const handle = await fs.open(temporary, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(state));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
  // Best-effort directory fsync so the rename itself survives a crash; unsupported platforms are ignored.
  try {
    const directoryHandle = await fs.open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    /* directory fsync unavailable */
  }
}
