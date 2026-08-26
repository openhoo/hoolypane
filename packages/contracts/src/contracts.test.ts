import { describe, expect, it } from "vitest";
import { ActionSchema } from "./action.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FAILURE_REASON_MAX_LENGTH, errorMessage, failureReason, isErrnoException } from "./errors.js";
import { ActionEnvelopeSchema, BoundsSnapshotSchema, ChromeCommandSchema, ChromeStateSchema, GET_BY_ROLE_ROLES, HoolypaneConfigSchema, PaneGenerationSchema, REPLAY_RESULT_PHASES, RecordFailureSchema, ReplayRequestSchema, ReplayResultSchema, VIEWPORT_PRESETS, WorkspaceStateSchema, defaultWorkspace, staleGenerationMessage } from "./index.js";

describe("configuration", () => {
  it("applies all recording defaults", () => {
    const result = HoolypaneConfigSchema.parse({ viewports: [VIEWPORT_PRESETS[0]] });
    expect(result.timeoutMs).toBe(30_000);
    expect(result.recording).toEqual({
      fps: 60,
      jpegQuality: 85,
      compositeMaxSize: { width: 3840, height: 2160 },
      compositeBackground: "#111318",
      outputDir: "hoolypane-results",
      keepRaw: false,
    });
  });

  it("rejects unsupported recording values", () => {
    expect(HoolypaneConfigSchema.safeParse({ viewports: [VIEWPORT_PRESETS[0]], recording: { fps: 24 } }).success).toBe(false);
    expect(HoolypaneConfigSchema.safeParse({ viewports: [VIEWPORT_PRESETS[0]], recording: { jpegQuality: 100.5 } }).success).toBe(false);
    expect(HoolypaneConfigSchema.safeParse({ viewports: [VIEWPORT_PRESETS[0]], recording: { compositeMaxSize: { width: 16_384, height: 2160 } } }).success).toBe(false);
  });

  it("normalizes explicitly-undefined recording keys to defaults", () => {
    const result = HoolypaneConfigSchema.parse({ viewports: [VIEWPORT_PRESETS[0]], recording: { fps: undefined, outputDir: undefined } });
    expect(result.recording.fps).toBe(60);
    expect(result.recording.outputDir).toBe("hoolypane-results");
  });

});

describe("action language", () => {
  it("round-trips every action form", () => {
    const locator = { kind: "testId", value: "subject" } as const;
    const actions = [
      { kind: "navigate", url: "https://example.test" },
      { kind: "click", locator },
      { kind: "fill", locator, value: "hello" },
      { kind: "select", locator, values: ["one"] },
      { kind: "check", locator, checked: true },
      { kind: "press", locator, key: "Enter" },
      { kind: "scroll", locator, horizontalRatio: 0.25, verticalRatio: 0.75 },
    ];
    expect(actions.map((action) => ActionSchema.parse(action))).toEqual(actions);
    const envelope = { actionId: 1, documentGeneration: 0, sourcePaneId: "pane-1", action: actions[1]! };
    expect(ActionEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });
});

describe("action language edge cases", () => {
  const locator = { kind: "testId", value: "subject" } as const;

  it("accepts an emptied multi-select as a deselect-all step", () => {
    expect(ActionSchema.parse({ kind: "select", locator, values: [] })).toEqual({ kind: "select", locator, values: [] });
  });

  it("restricts navigate URLs to http and https", () => {
    expect(ActionSchema.safeParse({ kind: "navigate", url: "https://example.test" }).success).toBe(true);
    expect(ActionSchema.safeParse({ kind: "navigate", url: "file:///etc/passwd" }).success).toBe(false);
    expect(ActionSchema.safeParse({ kind: "navigate", url: "javascript:alert(1)" }).success).toBe(false);
  });
});

describe("workspace state", () => {
  it("round-trips the default workspace and requires chrome extensions", () => {
    const workspace = defaultWorkspace();
    expect(WorkspaceStateSchema.parse(workspace)).toEqual(workspace);
    const chrome = { ...workspace, recording: false, lastError: null };
    expect(ChromeStateSchema.parse(chrome)).toEqual(chrome);
    expect(ChromeStateSchema.safeParse(workspace).success).toBe(false);
  });

  it("keeps workspace invariants on the extended chrome schema", () => {
    const chrome = { ...defaultWorkspace(), recording: true, lastError: null };
    expect(ChromeStateSchema.safeParse({ ...chrome, focusedPaneId: "missing-pane" }).success).toBe(false);
    expect(ChromeStateSchema.safeParse({ ...chrome, order: [...chrome.order].reverse().slice(1) }).success).toBe(false);
    expect(ChromeStateSchema.safeParse({ ...chrome, sharedUrl: "file:///etc/passwd" }).success).toBe(false);
  });

  it("rejects duplicate pane ids and duplicated order entries", () => {
    const workspace = defaultWorkspace();
    const [first] = workspace.panes;
    const duplicatePanes = WorkspaceStateSchema.safeParse({ ...workspace, panes: [first!, first!], order: [first!.id, first!.id] });
    if (duplicatePanes.success) throw new Error("expected duplicate pane ids to be rejected");
    expect(duplicatePanes.error.issues.some((issue) => issue.path.join(".") === "panes")).toBe(true);
    const duplicatedOrder = [...workspace.order];
    duplicatedOrder[1] = workspace.order[0]!;
    const result = WorkspaceStateSchema.safeParse({ ...workspace, order: duplicatedOrder });
    if (result.success) throw new Error("expected duplicated order entries to be rejected");
    expect(result.error.issues.some((issue) => issue.path.join(".") === "order")).toBe(true);
  });

  it("restricts recorded action kinds to the action language", () => {
    const chrome = { ...defaultWorkspace(), recording: true, lastError: null };
    const pane = { ...chrome.panes[0]!, outOfSync: { actionId: 1, actionKind: "hover", reason: "unsupported" } };
    expect(ChromeStateSchema.safeParse({ ...chrome, panes: [pane], order: [pane.id] }).success).toBe(false);
  });
});

describe("emulation state", () => {
  const emulationDefaults = { colorScheme: "auto", reducedMotion: false, throttling: "none", overlays: { outlines: false, disableImages: false, showRoles: false } };

  it("ships emulation defaults on the default workspace", () => {
    const workspace = defaultWorkspace();
    expect(workspace.emulation).toEqual(emulationDefaults);
    expect(WorkspaceStateSchema.parse(workspace)).toEqual(workspace);
  });

  it("fills emulation defaults into legacy workspaces without the field", () => {
    const workspace = defaultWorkspace();
    const legacy: Record<string, unknown> = { ...workspace };
    delete legacy.emulation;
    expect(WorkspaceStateSchema.parse(legacy)).toEqual(workspace);
  });

  it("completes partially specified emulation settings", () => {
    const parsed = WorkspaceStateSchema.parse({ ...defaultWorkspace(), emulation: { colorScheme: "dark", overlays: { outlines: true } } });
    expect(parsed.emulation).toEqual({ colorScheme: "dark", reducedMotion: false, throttling: "none", overlays: { outlines: true, disableImages: false, showRoles: false } });
  });

  it("rejects unknown emulation values", () => {
    expect(WorkspaceStateSchema.safeParse({ ...defaultWorkspace(), emulation: { colorScheme: "sepia" } }).success).toBe(false);
    expect(WorkspaceStateSchema.safeParse({ ...defaultWorkspace(), emulation: { throttling: "fiber" } }).success).toBe(false);
    expect(WorkspaceStateSchema.safeParse({ ...defaultWorkspace(), emulation: { overlays: { outlines: "yes" } } }).success).toBe(false);
    expect(WorkspaceStateSchema.safeParse({ ...defaultWorkspace(), emulation: { unexpected: true } }).success).toBe(false);
  });
});

describe("emulation commands", () => {
  it("parses every global emulation command", () => {
    const commands = [
      { kind: "set-color-scheme", value: "dark" },
      { kind: "set-reduced-motion", enabled: true },
      { kind: "set-throttling", mode: "slow3g" },
      { kind: "set-overlay", key: "showRoles", enabled: false },
    ];
    expect(commands.map((command) => ChromeCommandSchema.parse(command))).toEqual(commands);
  });

  it("rejects malformed emulation commands", () => {
    expect(ChromeCommandSchema.safeParse({ kind: "set-color-scheme", value: "sepia" }).success).toBe(false);
    expect(ChromeCommandSchema.safeParse({ kind: "set-throttling", mode: "5g" }).success).toBe(false);
    expect(ChromeCommandSchema.safeParse({ kind: "set-overlay", key: "grids", enabled: true }).success).toBe(false);
    expect(ChromeCommandSchema.safeParse({ kind: "set-overlay", key: "outlines" }).success).toBe(false);
    expect(ChromeCommandSchema.safeParse({ kind: "set-reduced-motion", enabled: true, extra: true }).success).toBe(false);
  });
});

describe("ipc wire schemas", () => {
  const click = { kind: "click", locator: { kind: "testId", value: "subject" } } as const;

  it("round-trips every replay request phase and reserves confirm for results", () => {
    for (const phase of ["resolve", "apply-dom", "end"] as const) {
      const request = { actionId: 1, documentGeneration: 0, action: click, phase };
      expect(ReplayRequestSchema.parse(request)).toEqual(request);
    }
    expect(ReplayRequestSchema.safeParse({ actionId: 1, documentGeneration: 0, action: click, phase: "confirm" }).success).toBe(false);
  });

  it("round-trips every replay result phase including the confirmation echo", () => {
    for (const phase of REPLAY_RESULT_PHASES) {
      const result = { actionId: 2, phase, ok: true };
      expect(ReplayResultSchema.parse(result)).toEqual(result);
    }
    expect(ReplayResultSchema.safeParse({ actionId: 2, phase: "teardown", ok: true }).success).toBe(false);
    expect(ReplayResultSchema.safeParse({ actionId: 2, phase: "confirm", ok: true, extra: true }).success).toBe(false);
  });

  it("caps failure reasons at FAILURE_REASON_MAX_LENGTH", () => {
    const reason = "x".repeat(FAILURE_REASON_MAX_LENGTH);
    expect(RecordFailureSchema.parse({ reason })).toEqual({ reason });
    expect(RecordFailureSchema.safeParse({ reason: `${reason}!` }).success).toBe(false);
    expect(RecordFailureSchema.safeParse({}).success).toBe(false);
  });

  it("keeps bounds snapshots integral and nonnegative", () => {
    const snapshot = { windowWidth: 1600, windowHeight: 1000, panes: [{ paneId: "pane-1", bounds: { x: 0, y: 8, width: 360, height: 640 } }] };
    expect(BoundsSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    const floatPane = { paneId: "pane-1", bounds: { x: 0, y: 8.5, width: 360, height: 640 } };
    const negativePane = { paneId: "pane-1", bounds: { x: 0, y: 8, width: -360, height: 640 } };
    expect(BoundsSnapshotSchema.safeParse({ ...snapshot, windowWidth: 1600.5 }).success).toBe(false);
    expect(BoundsSnapshotSchema.safeParse({ ...snapshot, windowHeight: -1 }).success).toBe(false);
    expect(BoundsSnapshotSchema.safeParse({ ...snapshot, panes: [floatPane] }).success).toBe(false);
    expect(BoundsSnapshotSchema.safeParse({ ...snapshot, panes: [negativePane] }).success).toBe(false);
    expect(BoundsSnapshotSchema.safeParse({ ...snapshot, extra: true }).success).toBe(false);
  });

  it("requires nonnegative integer document generations and derives stale messages", () => {
    expect(PaneGenerationSchema.parse({ documentGeneration: 0 })).toEqual({ documentGeneration: 0 });
    expect(PaneGenerationSchema.safeParse({ documentGeneration: -1 }).success).toBe(false);
    expect(PaneGenerationSchema.safeParse({ documentGeneration: 1.5 }).success).toBe(false);
    expect(staleGenerationMessage(3, 7)).toBe("stale document generation 3, current 7");
  });
});

describe("error normalization", () => {
  it("normalizes throwables and caps reasons to the contractual length", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("raw")).toBe("raw");
    expect(failureReason(new Error("short"))).toBe("short");
    expect(failureReason("x".repeat(FAILURE_REASON_MAX_LENGTH + 5))).toHaveLength(FAILURE_REASON_MAX_LENGTH);
    expect(failureReason(new Error("y".repeat(FAILURE_REASON_MAX_LENGTH + 5)))).toHaveLength(FAILURE_REASON_MAX_LENGTH);
  });

  it("discriminates errno codes on caught values of any shape", () => {
    const gone = Object.assign(new Error("gone"), { code: "ENOENT" });
    expect(isErrnoException(gone, "ENOENT")).toBe(true);
    expect(isErrnoException(gone, "EACCES")).toBe(false);
    expect(isErrnoException(null, "ENOENT")).toBe(false);
    expect(isErrnoException(undefined, "ENOENT")).toBe(false);
    expect(isErrnoException("ENOENT", "ENOENT")).toBe(false);
    expect(isErrnoException(42, "ENOENT")).toBe(false);
    expect(isErrnoException({ code: "EACCES" }, "ENOENT")).toBe(false);
    expect(isErrnoException({ code: null }, "ENOENT")).toBe(false);
  });
});

function playwrightCoreBundlePath(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const store = path.join(dir, "node_modules", ".pnpm");
    if (existsSync(store)) {
      const versions = readdirSync(store).filter((entry) => entry.startsWith("playwright-core@")).sort();
      const [version] = versions;
      if (version === undefined || versions.length !== 1) throw new Error(`Expected exactly one installed playwright-core version, found [${versions.join(", ")}]`);
      return path.join(store, version, "node_modules", "playwright-core", "lib", "coreBundle.js");
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("pnpm store not found above packages/contracts");
    dir = parent;
  }
}

/** Reads the injected-script validRoles array out of the installed playwright-core bundle so drift against a Playwright upgrade fails here instead of deadlocking recorded flows. */
function playwrightCoreValidRoles(): readonly string[] {
  const bundle = readFileSync(playwrightCoreBundlePath(), "utf8");
  const declaration = bundle.match(/var validRoles\s*=\s*\[/);
  if (!declaration || declaration.index === undefined) throw new Error("validRoles declaration not found in coreBundle.js");
  const end = bundle.indexOf("]", declaration.index + declaration[0].length);
  return [...bundle.slice(declaration.index + declaration[0].length, end).matchAll(/"([A-Za-z]+)"/g)].flatMap((match) => (match[1] ? [match[1]] : []));
}

describe("getByRole role table", () => {
  // The recorder-derived subset that apps/desktop/src/preload/pane.ts pins via `satisfies` to this
  // table (IMPLICIT_ROLES) — a name missing from the table makes flow codegen export the
  // [role="..."] attribute fallback, which only matches explicit role attributes and therefore
  // replays zero matches until the flow deadline.
  const recorderImplicitRoles = ["button", "link", "combobox", "textbox", "checkbox", "radio", "searchbox", "spinbutton", "slider"] as const;

  it("covers every implicit role the recorder derives", () => {
    for (const role of recorderImplicitRoles) expect(Object.hasOwn(GET_BY_ROLE_ROLES, role)).toBe(true);
  });

  it("stays identical to the installed playwright-core validRoles set", () => {
    const validRoles = playwrightCoreValidRoles();
    expect(validRoles.length).toBeGreaterThan(50);
    const missingFromTable = validRoles.filter((role) => !Object.hasOwn(GET_BY_ROLE_ROLES, role));
    const unknownToPlaywright = Object.keys(GET_BY_ROLE_ROLES).filter((role) => !validRoles.includes(role));
    expect(missingFromTable).toEqual([]);
    expect(unknownToPlaywright).toEqual([]);
  });
});
