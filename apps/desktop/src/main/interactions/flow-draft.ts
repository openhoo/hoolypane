import { ActionEnvelopeSchema, type ActionEnvelope } from "@hoolypane/contracts";
import { serializeFlow } from "@hoolypane/flow";

export class FlowDraft {
  private envelopes: ActionEnvelope[] = [];
  private blocking = new Map<number, string[]>();
  private active = false;

  start(url: string, sourcePaneId: string, actionId: number, recordedAtUnixMs: number): void {
    this.active = true;
    this.blocking.clear();
    this.envelopes = [ActionEnvelopeSchema.parse({ actionId, documentGeneration: 0, sourcePaneId, action: { kind: "navigate", url }, recordedAtUnixMs })];
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

  stop(): string | null {
    this.active = false;
    if (this.blocking.size > 0) {
      const reasons = [...this.blocking.entries()].flatMap(([actionId, values]) => values.map((value) => `action ${actionId}: ${value}`));
      throw new Error(`Flow cannot be exported:\n${reasons.join("\n")}`);
    }
    if (this.envelopes.length <= 1) return null;
    return serializeFlow(this.envelopes, "@hoolypane/runner");
  }

  cancel(): void {
    this.active = false;
    this.envelopes = [];
    this.blocking.clear();
  }

  get isActive(): boolean { return this.active; }
}
