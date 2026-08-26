import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChromeCommand, ChromeState } from "@hoolypane/contracts";

type DevMockBridge = {
  subscribe(callback: (value: unknown) => void): () => void;
  send(command: ChromeCommand): void;
};

// Minimal window stand-in: installDevMock only touches setTimeout and defines
// hoolypaneChrome; the node test env has no DOM window to borrow.
interface WindowStub {
  setTimeout(handler: () => void, timeout?: number): number;
  hoolypaneChrome?: DevMockBridge;
}

// Named unchecked cast with reason: the type checker resolves `window` to the
// full DOM Window type while the runtime here only carries devMock's tiny
// timer-plus-bridge surface, so the stub is installed through one explicit
// boundary cast instead of an inference-hostile intersection.
const globals = globalThis as unknown as { window?: WindowStub };

let bridge: DevMockBridge;

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

// devMock keeps its workspace in module state, so every test needs a fresh
// module instance: static imports stay bound to the first instance, and only a
// dynamic import observes the vi.resetModules() registry swap.
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  globals.window = {
    // Delegate to the faked global timers so settleLoading stays deterministic.
    // The number cast only papers over DOM-vs-node timer typings.
    setTimeout: (handler, timeout) => setTimeout(handler, timeout) as unknown as number,
  };
  const devMock = await import("./devMock.js");
  devMock.installDevMock();
  bridge = globals.window.hoolypaneChrome!;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete globals.window;
});

/** Subscribes before any command so published states can be observed synchronously. */
async function initialize(): Promise<() => ChromeState> {
  let latest!: ChromeState;
  bridge.subscribe((value) => {
    latest = value as ChromeState; // published values passed ChromeStateSchema.parse in patch()
  });
  await flushMicrotasks(); // drain subscribe's queueMicrotask replay of the current state
  return () => latest;
}

describe("renderer dev-mock chrome bridge", () => {
  it("accumulates overlapping settles so every loaded pane clears in a single flush", async () => {
    const latest = await initialize();
    expect(latest().order.length).toBeGreaterThan(1);
    expect(latest().panes.every((pane) => !pane.loading)).toBe(true);

    // Navigate loads every pane and schedules the settle tail.
    bridge.send({ kind: "navigate", url: "https://example.com/wave16" });
    expect(latest().panes.every((pane) => pane.loading)).toBe(true);

    // A reload landing mid-tail must accumulate onto the navigate targets instead of
    // rescheduling over them — the historical clear-and-reschedule wedge left panes
    // not named by the newest caller stuck in loading:true forever.
    vi.advanceTimersByTime(300);
    bridge.send({ kind: "reload", paneId: latest().order[0]! });
    expect(latest().panes.every((pane) => pane.loading)).toBe(true);

    vi.advanceTimersByTime(300);
    expect(latest().panes.every((pane) => !pane.loading)).toBe(true);

    // Exactly one flush fired: further elapsed time publishes nothing new.
    const settled = latest();
    vi.advanceTimersByTime(5000);
    expect(latest()).toBe(settled);
  });

  it("refuses a repeated record-start via lastError and skips the success-tail reset", async () => {
    const latest = await initialize();

    bridge.send({ kind: "record-start" });
    expect(latest().recording).toBe(true);
    expect(latest().lastError).toBeNull();

    bridge.send({ kind: "record-start" });
    expect(latest().recording).toBe(true);
    expect(latest().lastError).toBe("a flow recording is already active");

    // The next successful command still resets lastError via the success tail,
    // proving the refusal itself skipped it rather than lastError being sticky.
    bridge.send({ kind: "record-stop" });
    expect(latest().recording).toBe(false);
    expect(latest().lastError).toBeNull();
  });
});
