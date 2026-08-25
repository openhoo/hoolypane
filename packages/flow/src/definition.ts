import type { HoolypaneConfig, ResolvedHoolypaneConfig, ViewportSpec, FlowEvent } from "@hoolypane/contracts";
import { HoolypaneConfigSchema } from "@hoolypane/contracts";
import type { Page } from "playwright";

export interface Screen {
  readonly id: string;
  readonly viewport: Readonly<ViewportSpec>;
  readonly page: Page;
}

interface FlowContext {
  all(label: string, action: (screen: Screen) => Promise<void>): Promise<void>;
}

export interface FlowDefinition {
  readonly run: (context: FlowContext) => Promise<void>;
}
export function defineConfig(config: HoolypaneConfig): ResolvedHoolypaneConfig {
  return HoolypaneConfigSchema.parse(config);
}

export function defineFlow(run: (context: FlowContext) => Promise<void>): FlowDefinition {
  return Object.freeze({ run });
}

export function createFlowContext(screens: readonly Screen[], onEvent?: (event: FlowEvent) => void, signal?: AbortSignal): FlowContext {
  const immutableScreens = Object.freeze(screens.map((screen) => Object.freeze({ ...screen, viewport: Object.freeze({ ...screen.viewport }) })));
  return Object.freeze({
    async all(label: string, action: (screen: Screen) => Promise<void>): Promise<void> {
      // Checked BETWEEN user steps: in-flight screen actions finish, but the next step refuses to
      // start once the runner signaled cancellation.
      if (signal?.aborted) throw new Error(`Flow aborted before step: ${label}`);
      onEvent?.({ label, phase: "start", atUnixMs: Date.now() });
      const pending = immutableScreens.map((screen) => {
        try { return action(screen); } catch (error) { return Promise.reject(error); }
      });
      const settled = await Promise.allSettled(pending);
      const failures = settled.flatMap((result, index) => result.status === "rejected" ? [{ screenId: immutableScreens[index]!.id, reason: result.reason }] : []);
      if (failures.length > 0) {
        onEvent?.({ label, phase: "failed", atUnixMs: Date.now() });
        throw new AggregateError(failures.map((failure) => failure.reason), `${label} failed on ${failures.map((failure) => failure.screenId).join(", ")}`);
      }
      onEvent?.({ label, phase: "complete", atUnixMs: Date.now() });
    },
  });
}
