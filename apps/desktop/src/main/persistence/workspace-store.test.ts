import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceStateSchema } from "../panes/workspace.js";
import { flushWorkspaceSaves, loadWorkspace, saveWorkspace, sweepStaleTemporaries } from "./workspace-store.js";

const directories: string[] = [];

async function workspaceFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hoolypane-workspace-"));
  directories.push(directory);
  return join(directory, "workspace.json");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("loadWorkspace", () => {
  it("returns defaults for a missing file and keeps the session persistable", async () => {
    const loaded = await loadWorkspace(await workspaceFile());
    expect(loaded.persistable).toBe(true);
    expect(() => WorkspaceStateSchema.parse(loaded.state)).not.toThrow();
  });

  it("round-trips a saved workspace", async () => {
    const file = await workspaceFile();
    const loaded = await loadWorkspace(file);
    await saveWorkspace(file, loaded.state);
    const reread = await loadWorkspace(file);
    expect(reread.persistable).toBe(true);
    expect(reread.state).toEqual(loaded.state);
  });

  it("quarantines a corrupt file instead of overwriting it", async () => {
    const file = await workspaceFile();
    const corrupt = "{ not json at all";
    await writeFile(file, corrupt, "utf8");
    const loaded = await loadWorkspace(file);
    expect(loaded.persistable).toBe(true);
    expect(loaded.state.version).toBe(1);
    const siblings = await readdir(join(file, ".."));
    const quarantined = siblings.find((entry) => entry.startsWith("workspace.json.corrupt-"));
    expect(quarantined).toBeDefined();
    expect(await readFile(join(join(file, ".."), quarantined!), "utf8")).toBe(corrupt);
  });

  it("quarantines a schema-invalid payload", async () => {
    const file = await workspaceFile();
    await writeFile(file, JSON.stringify({ version: 1, panes: "nope" }), "utf8");
    const loaded = await loadWorkspace(file);
    expect(loaded.persistable).toBe(true);
    const siblings = await readdir(join(file, ".."));
    expect(siblings.some((entry) => entry.startsWith("workspace.json.corrupt-"))).toBe(true);
  });

  it("refuses to touch a file written by a newer version", async () => {
    const file = await workspaceFile();
    const newer = JSON.stringify({ ...JSON.parse(await freshStateJson()), version: 2 });
    await writeFile(file, newer, "utf8");
    const loaded = await loadWorkspace(file);
    expect(loaded.persistable).toBe(false);
    expect(await readFile(file, "utf8")).toBe(newer); // original bytes survive a downgrade
    const siblings = await readdir(join(file, ".."));
    expect(siblings.some((entry) => entry.startsWith("workspace.json.corrupt-"))).toBe(false);
  });
  it("drops position entries for panes that no longer exist", async () => {
    const file = await workspaceFile();
    const loaded = await loadWorkspace(file);
    const known = loaded.state.panes[0]!.id;
    const withGhost = { ...loaded.state, positions: { [known]: { x: 1, y: 2 }, ghostId: { x: 9, y: 9 } } };
    await saveWorkspace(file, withGhost);
    const reread = await loadWorkspace(file);
    expect(reread.persistable).toBe(true);
    expect(reread.state.positions).toEqual({ [known]: { x: 1, y: 2 } });
  });
});

async function freshStateJson(): Promise<string> {
  const file = await workspaceFile();
  const loaded = await loadWorkspace(file);
  await saveWorkspace(file, loaded.state);
  return readFile(file, "utf8");
}

describe("sweepStaleTemporaries", () => {
  it("removes orphaned tmp siblings but keeps the real file", async () => {
    const file = await workspaceFile();
    await writeFile(file, "real", "utf8");
    await writeFile(`${file}.999.123-1.tmp`, "orphan", "utf8");
    await writeFile(`${file}.unrelated.tmp`, "orphan2", "utf8");
    await sweepStaleTemporaries(file);
    expect(await readFile(file, "utf8")).toBe("real");
    const siblings = await readdir(join(file, ".."));
    expect(siblings.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});

describe("flushWorkspaceSaves", () => {
  it("drains chained saves so the last enqueued state lands on disk", async () => {
    const file = await workspaceFile();
    const base = (await loadWorkspace(file)).state;
    const mutated = { ...base, sharedUrl: "https://example.com/flushed" };
    await saveWorkspace(file, base);
    const second = saveWorkspace(file, () => mutated); // provider evaluated when the tail executes
    await flushWorkspaceSaves();
    await second;
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(mutated);
    const siblings = await readdir(join(file, ".."));
    expect(siblings.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});
