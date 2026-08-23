import { ActionEnvelopeSchema, type ActionEnvelope } from "@hoolypane/contracts";
import { serializeFlow } from "@hoolypane/flow";

type FlowStopResult = { kind: "saved"; source: string } | { kind: "empty" } | { kind: "blocked"; reasons: string[] };
export class FlowDraft {
  private envelopes: ActionEnvelope[] = [];
  // Keyed by `${actionId}:${paneId}`: one pane's success must not erase another pane's failure reasons.
  private blocking = new Map<string, string[]>();
  private active = false;
  // Bumped by every start(): envelopes captured under an older session are ignored on append,
  // so a drain that outlives its recording cannot pollute the next one.
  private generation = 0;

  start(url: string, sourcePaneId: string, actionId: number, recordedAtUnixMs: number): void {
    const envelope = ActionEnvelopeSchema.parse({ actionId, documentGeneration: 0, sourcePaneId, action: { kind: "navigate", url }, recordedAtUnixMs });
    this.generation += 1;
    this.active = true;
    this.blocking.clear();
    this.envelopes = [envelope];
  }

  append(envelope: ActionEnvelope, generation: number = this.generation): void {
    if (!this.active || generation !== this.generation) return;
    this.envelopes.push(ActionEnvelopeSchema.parse(envelope));
  }

  block(actionId: number, paneId: string, reason: string): void {
    if (!this.active) return;
    const key = `${actionId}:${paneId}`;
    const reasons = this.blocking.get(key) ?? [];
    reasons.push(reason);
    this.blocking.set(key, reasons);
  }

  unblock(actionId: number, paneId: string): void {
    this.blocking.delete(`${actionId}:${paneId}`);
  }

  /** Computes the export outcome without mutating the draft; callers commit only after a successful save. */
  stop(): FlowStopResult {
    if (!this.active) return { kind: "empty" };
    if (this.blocking.size > 0) {
      const reasons = [...this.blocking.entries()].flatMap(([key, values]) => {
        const separator = key.indexOf(":");
        const actionId = Number(key.slice(0, separator));
        const paneId = key.slice(separator + 1);
        return values.map((value) => `action ${actionId} (${paneId}): ${value}`);
      });
      return { kind: "blocked", reasons };
    }
    if (this.envelopes.length <= 1) return { kind: "empty" };
    return { kind: "saved", source: serializeFlow(this.envelopes, "@hoolypane/runner") };
  }

  /** Discards the recording. Only call once persistence succeeded (or the user abandoned the save). */
  commit(): void {
    this.active = false;
    this.envelopes = [];
    this.blocking.clear();
  }

  cancel(): void {
    this.active = false;
    this.envelopes = [];
    this.blocking.clear();
  }

  get sessionGeneration(): number { return this.generation; }
  get isActive(): boolean { return this.active; }
}
