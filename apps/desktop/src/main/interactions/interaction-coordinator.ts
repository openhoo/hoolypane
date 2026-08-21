import type { ActionEnvelope } from "@hoolypane/contracts";

type ReplayOutcome = { paneId: string; ok: boolean; reason?: string };

export class InteractionCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  async dispatch(envelope: ActionEnvelope, targetPaneIds: readonly string[], replay: (paneId: string, envelope: ActionEnvelope) => Promise<void>): Promise<ReplayOutcome[]> {
    const started = targetPaneIds.map((paneId) => {
      const previous = this.tails.get(paneId) ?? Promise.resolve();
      const task = previous.catch(() => undefined).then(() => replay(paneId, envelope));
      this.tails.set(paneId, task.catch(() => undefined));
      return task.then(
        (): ReplayOutcome => ({ paneId, ok: true }),
        (error: unknown): ReplayOutcome => ({ paneId, ok: false, reason: error instanceof Error ? error.message : String(error) }),
      );
    });
    return Promise.all(started);
  }

  cancelPane(paneId: string): void {
    this.tails.delete(paneId);
  }
}
