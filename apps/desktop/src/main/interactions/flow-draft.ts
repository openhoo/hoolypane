import { ActionEnvelopeSchema, type ActionEnvelope } from "@hoolypane/contracts";
import { serializeFlow } from "@hoolypane/flow";

type FlowStopResult = { kind: "saved"; source: string } | { kind: "empty" } | { kind: "blocked"; reasons: string[] };
type BlockingEntry = { actionId: number; paneId: string; reasons: string[] };

export class FlowDraft {
  private envelopes: ActionEnvelope[] = [];
  // Composite blocking key is built only in keyFor(); entries carry actionId/paneId so stop() never
  // re-parses keys. One pane's success must not erase another pane's failure reasons.
  private blocking = new Map<string, BlockingEntry>();
  private active = false;
  // Bumped by every start(): envelopes captured under an older session are ignored on append,
  // so a drain that outlives its recording cannot pollute the next one.
  private generation = 0;

  start(url: string, sourcePaneId: string, actionId: number): void {
    const envelope = ActionEnvelopeSchema.parse({ actionId, documentGeneration: 0, sourcePaneId, action: { kind: "navigate", url } });
    this.generation += 1;
    this.active = true;
    this.blocking.clear();
    this.envelopes = [envelope];
  }

  append(envelope: ActionEnvelope, generation: number): void {
    if (!this.active || generation !== this.generation) return;
    this.envelopes.push(ActionEnvelopeSchema.parse(envelope));
    // A later successful action recorded ON a pane proves it recovered: drop that pane's stale
    // replay-failure reasons so one transient miss cannot wedge the session until app restart.
    this.clearBlockingForPane(envelope.sourcePaneId);
  }

  /** Sole encoder of the composite blocking key; no code path decodes keys back into parts. */
  private keyFor(actionId: number, paneId: string): string {
    return `${actionId}:${paneId}`;
  }

  block(actionId: number, paneId: string, reason: string): void {
    if (!this.active) return;
    const key = this.keyFor(actionId, paneId);
    const entry = this.blocking.get(key) ?? { actionId, paneId, reasons: [] };
    entry.reasons.push(reason);
    this.blocking.set(key, entry);
  }

  unblock(actionId: number, paneId: string): void {
    this.blocking.delete(this.keyFor(actionId, paneId));
  }

  private clearBlockingForPane(paneId: string): void {
    for (const [key, entry] of this.blocking) {
      if (entry.paneId === paneId) this.blocking.delete(key);
    }
  }

  /** Drops a closed pane's blocking entries: its replay failures can never recover via a later
   *  recorded action on it, so keeping them would wedge every future stop() as blocked. */
  discardPane(paneId: string): void {
    this.clearBlockingForPane(paneId);
  }

  /** Computes the export outcome without mutating the draft; callers commit only after a successful save. */
  stop(): FlowStopResult {
    if (this.blocking.size > 0) {
      const reasons = [...this.blocking.values()].flatMap((entry) =>
        entry.reasons.map((value) => `action ${entry.actionId} (${entry.paneId}): ${value}`),
      );
      return { kind: "blocked", reasons };
    }
    if (this.envelopes.length <= 1) return { kind: "empty" };
    return { kind: "saved", source: serializeFlow(this.envelopes) };
  }

  /** Discards the recording. Only call once persistence succeeded (or the user abandoned the save). */
  commit(): void {
    this.active = false;
    this.envelopes = [];
    this.blocking.clear();
  }

  get sessionGeneration(): number { return this.generation; }
  get isActive(): boolean { return this.active; }
}
