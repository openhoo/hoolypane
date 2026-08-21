import { promises as fs } from "node:fs";
import { join } from "node:path";
import { WorkspaceStateSchema, defaultWorkspace, type WorkspaceState } from "../panes/workspace.js";

function decodeWorkspace(raw: string | null | undefined): WorkspaceState {
  if (!raw) return defaultWorkspace();
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = WorkspaceStateSchema.safeParse(parsed);
    return result.success ? result.data : defaultWorkspace();
  } catch { return defaultWorkspace(); }
}

export async function loadWorkspace(file: string): Promise<WorkspaceState> {
  try { return decodeWorkspace(await fs.readFile(file, "utf8")); } catch { return defaultWorkspace(); }
}

export async function saveWorkspace(file: string, state: WorkspaceState): Promise<void> {
  const directory = join(file, "..");
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, file);
}
