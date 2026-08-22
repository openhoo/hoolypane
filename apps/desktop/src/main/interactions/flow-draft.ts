import { ActionEnvelopeSchema, type ActionEnvelope } from "@hoolypane/contracts";
import { serializeFlow } from "@hoolypane/flow";

type FlowStopResult = { kind: "saved"; source: string } | { kind: "empty" } | { kind: "blocked"; reasons: string[] };
export class FlowDraft {
  private envelopes: ActionEnvelope[] = [];
  private blocking = new Map<number, string[]>();
  private active = false;

  start(url: string, sourcePaneId: string, actionId: number, recordedAtUnixMs: number): void {
    const envelope = ActionEnvelopeSchema.parse({ actionId, documentGeneration: 0, sourcePaneId, action: { kind: "navigate", url }, recordedAtUnixMs });
    this.active = true;
    this.blocking.clear();
    this.envelopes = [envelope];
  }

  append(envelope: ActionEnvelope): void {
    if (this.active) this.envelopes.push(ActionEnvelopeSchema.parse(envelope));
  }

  block(actionId: number, reason: string): void {
    if (!this.active) return;
    const reasons = this.blocking.get(actionId) ?? [];
    reasons.push(reason);
    this.blocking.set(actionId, reasons);
  }

  unblock(actionId: number): void {
    this.blocking.delete(actionId);
  }

  /** Computes the export outcome without mutating the draft; callers commit only after a successful save. */
  stop(): FlowStopResult {
    if (!this.active) return { kind: "empty" };
    if (this.blocking.size > 0) {
      const reasons = [...this.blocking.entries()].flatMap(([actionId, values]) => values.map((value) => `action ${actionId}: ${value}`));
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

  get isActive(): boolean { return this.active; }
}
