import type { HoolypaneConfig, ViewportSpec } from "@hoolypane/contracts";
import { HoolypaneConfigSchema } from "@hoolypane/contracts";
import type { Page } from "playwright";

export interface Screen {
  readonly id: string;
  readonly viewport: Readonly<ViewportSpec>;
  readonly page: Page;
}

export interface FlowContext {
  readonly screens: readonly Screen[];
  screen(id: string): Screen;
  all(label: string, action: (screen: Screen) => Promise<void>): Promise<void>;
}

export interface FlowDefinition {
  readonly run: (context: FlowContext) => Promise<void>;
}
export interface FlowEvent {
  readonly label: string;
  readonly phase: "start" | "complete" | "failed";
  readonly atUnixMs: number;
}

export function defineConfig(config: HoolypaneConfig): HoolypaneConfig {
  return HoolypaneConfigSchema.parse(config);
}

export function defineFlow(run: (context: FlowContext) => Promise<void>): FlowDefinition {
  return Object.freeze({ run });
}

export function createFlowContext(screens: readonly Screen[], onEvent?: (event: FlowEvent) => void): FlowContext {
  const immutableScreens = Object.freeze(screens.map((screen) => Object.freeze({ ...screen, viewport: Object.freeze({ ...screen.viewport }) })));
  const byId = new Map(immutableScreens.map((screen) => [screen.id, screen]));
  if (byId.size !== immutableScreens.length) {
    throw new Error("Flow screens must have unique ids");
  }
  return Object.freeze({
    screens: immutableScreens,
    screen(id: string): Screen {
      const found = byId.get(id);
      if (!found) throw new Error(`Unknown screen: ${id}`);
      return found;
    },
    async all(label: string, action: (screen: Screen) => Promise<void>): Promise<void> {
      onEvent?.({ label, phase: "start", atUnixMs: Date.now() });
      const pending = immutableScreens.map((screen) => {
        try { return action(screen); } catch (error) { return Promise.reject(error); }
      });
      const settled = await Promise.allSettled(pending);
      const failures = settled.flatMap((result, index) => result.status === "rejected" ? [{ screenId: immutableScreens[index]?.id ?? "unknown", reason: result.reason }] : []);
      if (failures.length > 0) {
        onEvent?.({ label, phase: "failed", atUnixMs: Date.now() });
        throw new AggregateError(failures.map((failure) => failure.reason), `${label} failed on ${failures.map((failure) => failure.screenId).join(", ")}`);
      }
      onEvent?.({ label, phase: "complete", atUnixMs: Date.now() });
    },
  });
}
