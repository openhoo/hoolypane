import { describe, expect, it } from "vitest";
import { createFlowContext, defineConfig, defineFlow, locatorExpression, serializeFlow } from "./index.js";
import { ActionEnvelopeSchema, VIEWPORT_PRESETS } from "@hoolypane/contracts";

describe("flow API", () => {
  it("validates config and preserves definition identity", () => {
    expect(defineConfig({ viewports: [VIEWPORT_PRESETS[0]!] }).timeoutMs).toBe(30_000);
    const run = async (): Promise<void> => undefined;
    expect(defineFlow(run).run).toBe(run);
  });

  it("starts every all callback before awaiting the barrier", async () => {
    const started: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const screens = ["one", "two", "three"].map((id, index) => ({ id, viewport: VIEWPORT_PRESETS[index]!, page: {} as never }));
    const context = createFlowContext(screens);
    const pending = context.all("barrier", async (screen) => {
      started.push(screen.id);
      await gate;
    });
    await Promise.resolve();
    expect(started).toEqual(["one", "two", "three"]);
    release?.();
    await pending;
  });

  it("serializes deterministic Playwright locators and actions", () => {
    expect(locatorExpression({ kind: "role", role: "button", name: "Save" })).toBe('page.getByRole("button", { name: "Save" })');
    const envelope = ActionEnvelopeSchema.parse({
      actionId: 7,
      documentGeneration: 2,
      sourcePaneId: "pane-1",
      action: { kind: "fill", locator: { kind: "label", value: "Email" }, value: "a@example.test" },
      recordedAtUnixMs: 100,
    });
    expect(serializeFlow([envelope])).toContain('await page.getByLabel("Email").fill("a@example.test");');
  });
});
