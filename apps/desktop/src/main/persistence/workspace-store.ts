import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import { errorMessage, isErrnoException, WORKSPACE_VERSION } from "@hoolypane/contracts";
import { writeFileAtomic } from "@hoolypane/contracts/fsync";
import { WorkspaceStateSchema, defaultWorkspace, type WorkspaceState } from "../panes/workspace.js";
import { report } from "../report.js";

type LoadedWorkspace = {
  state: WorkspaceState;
  /** false when the on-disk file is newer than supported or unreadable, or a corrupt file could not be quarantined: automatic overwriting is suppressed. */
  persistable: boolean;
};

function defaults(persistable: boolean): LoadedWorkspace {
  return { state: defaultWorkspace(), persistable };
}

let temporarySequence = 0;

/** Moves an unparseable file aside so the original bytes survive before defaults take over. */
async function quarantine(file: string): Promise<boolean> {
  try {
    await fs.rename(file, `${file}.corrupt-${process.pid}.${Date.now()}-${++temporarySequence}`);
    return true;
  } catch (error) {
    report("", `could not quarantine ${file}; treating it as unpersistable: ${errorMessage(error)}`);
    return false; // could not move aside: treat as unpersistable rather than clobbering
  }
}

export async function loadWorkspace(file: string): Promise<LoadedWorkspace> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) return defaults(true);
    report("", `workspace ${file} is unreadable, continuing with defaults: ${errorMessage(error)}`);
    return defaults(false);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    report("", `workspace ${file} is corrupt, quarantining it: ${errorMessage(error)}`);
    return defaults(await quarantine(file));
  }
  const version = typeof parsed === "object" && parsed !== null && "version" in parsed ? parsed.version : undefined;
  if (typeof version === "number" && version > WORKSPACE_VERSION) {
    report("", `workspace ${file} has unsupported version ${version}; leaving it untouched`);
    return defaults(false); // downgrade guard: never overwrite data written by a newer build
  }
  const result = WorkspaceStateSchema.safeParse(parsed);
  if (!result.success) {
    report("", `workspace ${file} failed validation, quarantining it: ${errorMessage(result.error)}`);
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
  const directory = dirname(file);
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

export async function saveWorkspace(file: string, state: WorkspaceState | (() => WorkspaceState)): Promise<void> {
  const previous = saveTails.get(file) ?? Promise.resolve();
  // A provider is evaluated when the tail executes, not when it is enqueued, so mutations
  // landing while earlier writes settle are still included.
  const task = previous.then(() => writeFileAtomic(file, JSON.stringify(typeof state === "function" ? state() : state)));
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
