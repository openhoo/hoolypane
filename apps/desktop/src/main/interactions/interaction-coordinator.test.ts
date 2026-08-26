import { describe, expect, it } from "vitest";
import { ActionEnvelopeSchema } from "@hoolypane/contracts";
import { FlowDraft } from "./flow-draft.js";
import { InteractionCoordinator } from "./interaction-coordinator.js";

const envelope = ActionEnvelopeSchema.parse({
  actionId: 1,
  documentGeneration: 1,
  sourcePaneId: "source",
  action: { kind: "click", locator: { kind: "testId", value: "save" } },
});

describe("interaction coordinator", () => {
  it("starts one action on every target before waiting", async () => {
    const coordinator = new InteractionCoordinator();
    const started: string[] = [];
    const gate = Promise.withResolvers<void>();
    const pending = coordinator.dispatch(["one", "two", "three"], async (paneId) => {
      started.push(paneId);
      await gate.promise;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["one", "two", "three"]);
    gate.resolve();
    expect(await pending).toEqual([{ paneId: "one", ok: true }, { paneId: "two", ok: true }, { paneId: "three", ok: true }]);
  });

  it("keeps FIFO ordering within each target", async () => {
    const coordinator = new InteractionCoordinator();
    const events: string[] = [];
    const first = coordinator.dispatch(["one"], async () => { events.push("first-start"); await Promise.resolve(); events.push("first-end"); });
    const second = coordinator.dispatch(["one"], async () => { events.push("second"); });
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });

  it("cancels a queued replay when its pane closes, while the running one settles normally", async () => {
    const coordinator = new InteractionCoordinator();
    const gate = Promise.withResolvers<void>();
    let started = false;
    const first = coordinator.dispatch(["one"], async () => { started = true; await gate.promise; });
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toBe(true);
    const second = coordinator.dispatch(["one"], async () => undefined);
    coordinator.cancelPane("one");
    gate.resolve();
    expect(await second).toEqual([{ paneId: "one", ok: false, reason: expect.stringMatching(/replay cancelled/) }]);
    expect(await first).toEqual([{ paneId: "one", ok: true }]);
  });

  it("maps a rejecting replay to a failed outcome, including non-Error throws", async () => {
    const coordinator = new InteractionCoordinator();
    const outcomes = await coordinator.dispatch(["one"], async () => {
      throw "locator exploded";
    });
    expect(outcomes).toEqual([{ paneId: "one", ok: false, reason: "locator exploded" }]);
  });

  it("still executes work dispatched after a cancelled predecessor on the same pane", async () => {
    const coordinator = new InteractionCoordinator();
    const gate = Promise.withResolvers<void>();
    const first = coordinator.dispatch(["one"], () => gate.promise);
    coordinator.cancelPane("one");
    gate.resolve();
    await expect(first).resolves.toEqual([{ paneId: "one", ok: false, reason: expect.stringMatching(/replay cancelled/) }]);
    let ran = false;
    const next = await coordinator.dispatch(["one"], async () => { ran = true; });
    expect(next).toEqual([{ paneId: "one", ok: true }]);
    expect(ran).toBe(true);
  });

  it("serializes a dispatch issued after cancelPane behind the still-settling predecessor", async () => {
    const coordinator = new InteractionCoordinator();
    const events: string[] = [];
    const gate = Promise.withResolvers<void>();
    const first = coordinator.dispatch(["one"], async () => {
      events.push("first-start");
      await gate.promise;
      events.push("first-end");
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["first-start"]);
    coordinator.cancelPane("one");
    const second = coordinator.dispatch(["one"], async () => { events.push("second"); });
    // Drain every pending microtask: if the post-cancel dispatch raced the settling
    // predecessor instead of chaining behind it, "second" would appear within these ticks.
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    expect(events).toEqual(["first-start"]);
    gate.resolve();
    expect(await first).toEqual([{ paneId: "one", ok: true }]);
    expect(await second).toEqual([{ paneId: "one", ok: true }]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });

  it("keeps post-cancelAll dispatches serialized behind their settling predecessors", async () => {
    const coordinator = new InteractionCoordinator();
    const events: string[] = [];
    const gate = Promise.withResolvers<void>();
    const first = coordinator.dispatch(["one", "two"], async (paneId) => {
      events.push(`first-${paneId}`);
      await gate.promise;
      events.push(`first-${paneId}-end`);
    });
    await Promise.resolve();
    await Promise.resolve();
    expect([...events].sort()).toEqual(["first-one", "first-two"]);
    coordinator.cancelAll();
    const second = coordinator.dispatch(["one", "two"], async (paneId) => { events.push(`second-${paneId}`); });
    // Same microtask drain as above proves neither pane's post-cancel successor starts early.
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    expect(events.some((event) => event.startsWith("second"))).toBe(false);
    gate.resolve();
    expect(await first).toEqual([{ paneId: "one", ok: true }, { paneId: "two", ok: true }]);
    expect(await second).toEqual([{ paneId: "one", ok: true }, { paneId: "two", ok: true }]);
    expect(events.filter((event) => event.startsWith("second")).sort()).toEqual(["second-one", "second-two"]);
  });

  it("cancels queued work on every pane via cancelAll while in-flight work settles", async () => {
    const coordinator = new InteractionCoordinator();
    const gate = Promise.withResolvers<void>();
    let started = false;
    const first = coordinator.dispatch(["one"], async () => { started = true; await gate.promise; });
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toBe(true);
    const second = coordinator.dispatch(["one"], async () => undefined);
    const third = coordinator.dispatch(["two"], async () => undefined);
    coordinator.cancelAll();
    gate.resolve();
    expect(await first).toEqual([{ paneId: "one", ok: true }]);
    expect(await second).toEqual([{ paneId: "one", ok: false, reason: expect.stringMatching(/replay cancelled/) }]);
    expect(await third).toEqual([{ paneId: "two", ok: false, reason: expect.stringMatching(/replay cancelled/) }]);
    let ran = false;
    const next = await coordinator.dispatch(["one", "two"], async () => { ran = true; });
    expect(next).toEqual([{ paneId: "one", ok: true }, { paneId: "two", ok: true }]);
    expect(ran).toBe(true);
  });

  it("keeps a mixed multi-pane action blocked with the failing reason intact", async () => {
    const coordinator = new InteractionCoordinator();
    const draft = new FlowDraft();
    draft.start("https://example.test", "desktop", 1);
    const pending = coordinator.dispatch(["phone", "desktop"], async (paneId) => {
      if (paneId === "phone") throw new Error("locator resolved 0 elements");
    });
    const outcomes = await pending;
    expect(outcomes).toEqual([
      { paneId: "phone", ok: false, reason: "locator resolved 0 elements" },
      { paneId: "desktop", ok: true },
    ]);

    // Main replay loop contract (per-pane blocking keys): a sibling pane's success must
    // never erase another pane's failure reasons for the same actionId.
    draft.append(envelope, draft.sessionGeneration);
    for (const outcome of outcomes) {
      if (outcome.ok) draft.unblock(envelope.actionId, outcome.paneId);
      else draft.block(envelope.actionId, outcome.paneId, outcome.reason ?? "unknown replay failure");
    }
    expect(draft.stop()).toEqual({ kind: "blocked", reasons: ["action 1 (phone): locator resolved 0 elements"] });
    expect(draft.isActive).toBe(true); // stays armed so recovery can resync and unblock
  });
});

describe("flow draft", () => {
  it("writes deterministic runnable source and blocks misses", () => {
    const draft = new FlowDraft();
    draft.start("https://example.test", "source", 1);
    draft.append({ ...envelope, actionId: 2 }, draft.sessionGeneration);
    expect(draft.stop()).toEqual({ kind: "saved", source: expect.stringContaining('import { defineFlow } from "@hoolypane/runner";') });

    draft.start("https://example.test", "source", 3);
    draft.append({ ...envelope, actionId: 4 }, draft.sessionGeneration);
    draft.block(4, "phone", "locator resolved 0 elements");
    expect(draft.stop()).toEqual({ kind: "blocked", reasons: ["action 4 (phone): locator resolved 0 elements"] });
  });

  it("drops appends while inactive and reports empty stops", () => {
    const draft = new FlowDraft();
    draft.append({ ...envelope, actionId: 9 }, draft.sessionGeneration);
    expect(draft.stop()).toEqual({ kind: "empty" });
    expect(draft.isActive).toBe(false);

    draft.start("https://example.test", "source", 1);
    expect(draft.stop()).toEqual({ kind: "empty" });
    expect(draft.isActive).toBe(true); // empty stop leaves the recording armed until commit
  });

  it("drops appends captured under an older session generation", () => {
    const draft = new FlowDraft();
    draft.start("https://example.test", "source", 1);
    const staleGeneration = draft.sessionGeneration;
    draft.start("https://example.test", "source", 5);
    draft.append({ ...envelope, actionId: 9 }, staleGeneration);
    // The stale envelope must be fenced off: the restart kept only its own navigate.
    expect(draft.stop()).toEqual({ kind: "empty" });
    // Positive control: the same append with the live generation exports, so this test
    // pins the generation fence and not an unrelated drop of every append.
    draft.append({ ...envelope, actionId: 10 }, draft.sessionGeneration);
    expect(draft.stop()).toEqual({ kind: "saved", source: expect.any(String) });
  });

  it("drops block() outcomes captured under an older session generation", () => {
    const draft = new FlowDraft();
    draft.start("https://example.test", "source", 1);
    const staleGeneration = draft.sessionGeneration;
    draft.start("https://example.test", "source", 5);
    draft.append({ ...envelope, actionId: 6 }, draft.sessionGeneration);
    draft.block(6, "phone", "replay lost a navigation race", staleGeneration);
    // The stale outcome must be fenced off: the restart's stop() stays exportable instead of
    // reporting session N+1 as blocked over a phantom key injected by session N.
    expect(draft.stop()).toEqual({ kind: "saved", source: expect.any(String) });
    // Positive control: the same block with the live generation wedges the stop, so this test
    // pins the generation fence and not an unrelated drop of every block.
    draft.block(6, "phone", "replay lost a navigation race");
    expect(draft.stop()).toEqual({ kind: "blocked", reasons: ["action 6 (phone): replay lost a navigation race"] });
  });

  it("drops unblock() outcomes captured under an older session generation", () => {
    const draft = new FlowDraft();
    draft.start("https://example.test", "source", 1);
    const staleGeneration = draft.sessionGeneration;
    draft.start("https://example.test", "source", 5);
    draft.append({ ...envelope, actionId: 6 }, draft.sessionGeneration);
    draft.block(6, "phone", "replay lost a navigation race");
    draft.unblock(6, "phone", staleGeneration);
    // The stale recovery must be fenced off: without the fence the composite key collides with
    // the restart's own failure and its stop() would silently export.
    expect(draft.stop()).toEqual({ kind: "blocked", reasons: ["action 6 (phone): replay lost a navigation race"] });
    // Positive control: the same unblock with the live generation clears the failure, so this
    // test pins the generation fence and not an unrelated drop of every unblock.
    draft.unblock(6, "phone");
    expect(draft.stop()).toEqual({ kind: "saved", source: expect.any(String) });
  });

  it("stays active on a blocked stop so recovery can clear it", () => {
    const draft = new FlowDraft();
    draft.start("https://example.test", "source", 1);
    draft.append({ ...envelope, actionId: 2 }, draft.sessionGeneration);
    draft.block(2, "phone", "navigation raced the replay");
    expect(draft.stop()).toEqual({ kind: "blocked", reasons: ["action 2 (phone): navigation raced the replay"] });
    expect(draft.isActive).toBe(true);
  });

  it("unblock removes recovered reasons so a later stop exports", () => {
    const draft = new FlowDraft();
    draft.start("https://example.test", "source", 1);
    draft.append({ ...envelope, actionId: 2 }, draft.sessionGeneration);
    draft.block(2, "phone", "replay timed out");
    draft.block(2, "phone", "replay timed out again");
    draft.unblock(2, "phone");
    const stopped = draft.stop();
    expect(stopped).toEqual({ kind: "saved", source: expect.any(String) });
    draft.commit();
    expect(draft.isActive).toBe(false);
    expect(draft.stop()).toEqual({ kind: "empty" });
  });

  it("start resets blocking from a previous recording", () => {
    const draft = new FlowDraft();
    draft.start("https://example.test", "source", 1);
    draft.append({ ...envelope, actionId: 2 }, draft.sessionGeneration);
    draft.block(2, "phone", "stale");
    draft.start("https://example.test", "source", 5);
    draft.append({ ...envelope, actionId: 6 }, draft.sessionGeneration);
    expect(draft.stop()).toEqual({ kind: "saved", source: expect.any(String) });
  });

  it("commit discards envelopes and deactivates", () => {
    const draft = new FlowDraft();
    draft.start("https://example.test", "source", 1);
    draft.append({ ...envelope, actionId: 2 }, draft.sessionGeneration);
    draft.commit();
    expect(draft.isActive).toBe(false);
    expect(draft.stop()).toEqual({ kind: "empty" });
  });

  it("a recorded success on a pane clears that pane's stale blocking reasons", () => {
    const draft = new FlowDraft();
    draft.start("https://example.test", "source", 1);
    draft.block(2, "phone", "locator resolved 0 elements");
    expect(draft.stop()).toEqual({ kind: "blocked", reasons: ["action 2 (phone): locator resolved 0 elements"] });
    draft.append({ ...envelope, actionId: 3, sourcePaneId: "phone" }, draft.sessionGeneration);
    expect(draft.stop()).toEqual({ kind: "saved", source: expect.any(String) });
  });

  it("discardPane drops a closed pane's reasons so a later stop exports", () => {
    const draft = new FlowDraft();
    draft.start("https://example.test", "source", 1);
    draft.append({ ...envelope, actionId: 2 }, draft.sessionGeneration);
    draft.block(2, "phone", "replay lost a navigation race");
    expect(draft.stop()).toEqual({ kind: "blocked", reasons: ["action 2 (phone): replay lost a navigation race"] });
    draft.discardPane("phone");
    expect(draft.stop()).toEqual({ kind: "saved", source: expect.any(String) });
  });
});
