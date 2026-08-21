import { describe, expect, it } from "vitest";
import { ActionEnvelopeSchema } from "@hoolypane/contracts";
import { FlowDraft } from "./flow-draft.js";
import { InteractionCoordinator } from "./interaction-coordinator.js";

const envelope = ActionEnvelopeSchema.parse({
  actionId: 1,
  documentGeneration: 1,
  sourcePaneId: "source",
  action: { kind: "click", locator: { kind: "testId", value: "save" } },
  recordedAtUnixMs: 1,
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
});

describe("flow draft", () => {
  it("writes deterministic runnable source and blocks misses", () => {
    const draft = new FlowDraft();
    draft.start("https://example.test", "source", 1, 1);
    draft.append({ ...envelope, actionId: 2 });
    expect(draft.stop()).toContain('import { defineFlow } from "@hoolypane/runner";');

    draft.start("https://example.test", "source", 3, 3);
    draft.append({ ...envelope, actionId: 4 });
    draft.block(4, "phone: locator resolved 0 elements");
    expect(() => draft.stop()).toThrow(/phone/);
  });
});
