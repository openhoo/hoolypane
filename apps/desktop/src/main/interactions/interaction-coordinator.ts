import { errorMessage } from "@hoolypane/contracts";

type ReplayOutcome = { paneId: string; ok: boolean; reason?: string };

export class InteractionCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly epochs = new Map<string, number>();

  async dispatch(targetPaneIds: readonly string[], replay: (paneId: string) => Promise<void>): Promise<ReplayOutcome[]> {
    const started = targetPaneIds.map((paneId) => {
      const previous = this.tails.get(paneId) ?? Promise.resolve();
      const epoch = this.epochs.get(paneId) ?? 0;
      const task = previous.then((): Promise<void> => {
        if ((this.epochs.get(paneId) ?? 0) !== epoch) throw new Error(`replay cancelled: pane ${paneId} was closed`);
        return replay(paneId);
      });
      this.tails.set(paneId, task.catch(() => undefined));
      return task.then(
        (): ReplayOutcome => ({ paneId, ok: true }),
        (error: unknown): ReplayOutcome => ({ paneId, ok: false, reason: errorMessage(error) }),
      );
    });
    return Promise.all(started);
  }

  cancelPane(paneId: string): void {
    this.epochs.set(paneId, (this.epochs.get(paneId) ?? 0) + 1);
    const tail = this.tails.get(paneId);
    if (!tail) return;
    // Keep the settling predecessor chained: a dispatch issued after the cancel must still
    // serialize behind it instead of racing its continuation. Prune once it settles so an
    // idle pane holds no tail; the identity guard never drops a newer post-cancel entry.
    void tail.finally(() => {
      if (this.tails.get(paneId) === tail) this.tails.delete(paneId);
    });
  }

  /** Cancels every queued replay: window teardown must fence outstanding work or a relaunch
   *  restoring the same pane ids executes stale replays against the new surfaces. */
  cancelAll(): void {
    for (const paneId of [...this.tails.keys()]) this.cancelPane(paneId);
  }
}
