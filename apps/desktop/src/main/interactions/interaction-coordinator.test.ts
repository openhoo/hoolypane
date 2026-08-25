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
    const pending = coordinator.dispatch(envelope, ["one", "two", "three"], async (paneId) => {
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
    const first = coordinator.dispatch(envelope, ["one"], async () => { events.push("first-start"); await Promise.resolve(); events.push("first-end"); });
    const second = coordinator.dispatch({ ...envelope, actionId: 2 }, ["one"], async () => { events.push("second"); });
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });

  it("cancels a queued replay when its pane closes, while the running one settles normally", async () => {
    const coordinator = new InteractionCoordinator();
    const gate = Promise.withResolvers<void>();
    let started = false;
    const first = coordinator.dispatch(envelope, ["one"], async () => { started = true; await gate.promise; });
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toBe(true);
    const second = coordinator.dispatch({ ...envelope, actionId: 2 }, ["one"], async () => undefined);
    coordinator.cancelPane("one");
    gate.resolve();
    expect(await second).toEqual([{ paneId: "one", ok: false, reason: expect.stringMatching(/replay cancelled/) }]);
    expect(await first).toEqual([{ paneId: "one", ok: true }]);
  });

  it("maps a rejecting replay to a failed outcome, including non-Error throws", async () => {
    const coordinator = new InteractionCoordinator();
    const outcomes = await coordinator.dispatch(envelope, ["one"], async () => {
      throw "locator exploded"; // eslint-disable-line no-throw-literal
    });
    expect(outcomes).toEqual([{ paneId: "one", ok: false, reason: "locator exploded" }]);
  });

  it("still executes work dispatched after a cancelled predecessor on the same pane", async () => {
    const coordinator = new InteractionCoordinator();
    const gate = Promise.withResolvers<void>();
    const first = coordinator.dispatch(envelope, ["one"], () => gate.promise);
    coordinator.cancelPane("one");
    gate.resolve();
    await expect(first).resolves.toEqual([{ paneId: "one", ok: false, reason: expect.stringMatching(/replay cancelled/) }]);
    let ran = false;
    const next = await coordinator.dispatch({ ...envelope, actionId: 3 }, ["one"], async () => { ran = true; });
    expect(next).toEqual([{ paneId: "one", ok: true }]);
    expect(ran).toBe(true);
  });

  it("keeps a mixed multi-pane action blocked with the failing reason intact", async () => {
    const coordinator = new InteractionCoordinator();
    const draft = new FlowDraft();
    draft.start("https://example.test", "desktop", 1);
    const pending = coordinator.dispatch(envelope, ["phone", "desktop"], async (paneId) => {
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
});
