import { describe, expect, it } from "vitest";
import ts from "typescript";
import { createFlowContext, defineConfig, defineFlow, locatorExpression, serializeFlow } from "./index.js";
import { ActionEnvelopeSchema, VIEWPORT_PRESETS } from "@hoolypane/contracts";
import type { Action, ActionEnvelope } from "@hoolypane/contracts";

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
    expect(locatorExpression({ kind: "role", role: "button", name: "Save" })).toBe('page.getByRole("button", { name: "Save", exact: true })');
    const envelope = ActionEnvelopeSchema.parse({
      actionId: 7,
      documentGeneration: 2,
      sourcePaneId: "pane-1",
      action: { kind: "fill", locator: { kind: "label", value: "Email" }, value: "a@example.test" },
      recordedAtUnixMs: 100,
    });
    expect(serializeFlow([envelope])).toContain('await page.getByLabel("Email", { exact: true }).fill("a@example.test");');
  });

  it("emits exact matching for every name-based locator kind", () => {
    expect(locatorExpression({ kind: "text", value: "Submit order" })).toBe('page.getByText("Submit order", { exact: true })');
    expect(locatorExpression({ kind: "label", value: "Email" })).toBe('page.getByLabel("Email", { exact: true })');
    expect(locatorExpression({ kind: "placeholder", value: "Search" })).toBe('page.getByPlaceholder("Search", { exact: true })');
    expect(locatorExpression({ kind: "testId", value: "checkout" })).toBe('page.getByTestId("checkout")');
    expect(locatorExpression({ kind: "css", value: "#main" })).toBe('page.locator("#main")');
  });

  it("serializes every action branch deterministically", () => {
    const envelope = (action: Action): ActionEnvelope => ActionEnvelopeSchema.parse({
      actionId: 1,
      documentGeneration: 0,
      sourcePaneId: "pane-1",
      action,
      recordedAtUnixMs: 0,
    });
    const source = serializeFlow([
      envelope({ kind: "navigate", url: "https://example.test/" }),
      envelope({ kind: "click", locator: { kind: "role", role: "button", name: "Go" } }),
      envelope({ kind: "select", locator: { kind: "label", value: "Size" }, values: ["m", "l"] }),
      envelope({ kind: "check", locator: { kind: "testId", value: "terms" }, checked: true }),
      envelope({ kind: "check", locator: { kind: "testId", value: "spam" }, checked: false }),
      envelope({ kind: "press", locator: { kind: "role", role: "textbox", name: "Search" }, key: "Enter" }),
      envelope({ kind: "scroll", locator: { kind: "css", value: "#feed" }, horizontalRatio: 0.5, verticalRatio: 1 }),
    ]);
    expect(source).toContain('await page.goto("https://example.test/");');
    expect(source).toContain('await page.getByRole("button", { name: "Go", exact: true }).click();');
    expect(source).toContain('await page.getByLabel("Size", { exact: true }).selectOption(["m","l"]);');
    expect(source).toContain('await page.getByTestId("terms").check();');
    expect(source).toContain('await page.getByTestId("spam").uncheck();');
    expect(source).toContain('await page.getByRole("textbox", { name: "Search", exact: true }).press("Enter");');
    expect(source).toContain('left: ratios.horizontal * Math.max(0, target.scrollWidth - target.clientWidth),');
    expect(source).toContain('top: ratios.vertical * Math.max(0, target.scrollHeight - target.clientHeight),');
    expect(source).toContain('}, { horizontal: 0.5, vertical: 1 });');
  });

  it("rejects scroll ratios outside the unit range before emitting statements", () => {
    const action = {
      kind: "scroll",
      locator: { kind: "css", value: "#feed" },
      horizontalRatio: 1.5,
      verticalRatio: 0,
    } as unknown as Action;
    expect(() => serializeFlow([{ actionId: 1, documentGeneration: 0, sourcePaneId: "pane-1", action, recordedAtUnixMs: 0 }])).toThrow(/Invalid scroll ratios/);
  });

  it("rejects unknown and duplicate screen ids", () => {
    const screens = [
      { id: "one", viewport: VIEWPORT_PRESETS[0]!, page: {} as never },
      { id: "one", viewport: VIEWPORT_PRESETS[1]!, page: {} as never },
    ];
    expect(() => createFlowContext(screens)).toThrow(/unique ids/i);
    const context = createFlowContext([{ id: "solo", viewport: VIEWPORT_PRESETS[0]!, page: {} as never }]);
    expect(() => context.screen("missing")).toThrow(/Unknown screen: missing/);
  });

  it("aggregates per-screen failures into an AggregateError with screen ids and a failed event", async () => {
    const events: unknown[] = [];
    const screens = ["one", "two"].map((id, index) => ({ id, viewport: VIEWPORT_PRESETS[index]!, page: {} as never }));
    const context = createFlowContext(screens, (event) => events.push(event));
    await expect(context.all("boom", async (screen) => {
      if (screen.id === "two") throw new Error("pane two exploded");
    })).rejects.toThrow(AggregateError);
    await expect(context.all("boom", async (screen) => {
      if (screen.id === "two") throw new Error("pane two exploded");
    })).rejects.toThrow(/boom failed on two/);
    expect(events).toEqual([
      { label: "boom", phase: "start", atUnixMs: expect.any(Number) },
      { label: "boom", phase: "failed", atUnixMs: expect.any(Number) },
      { label: "boom", phase: "start", atUnixMs: expect.any(Number) },
      { label: "boom", phase: "failed", atUnixMs: expect.any(Number) },
    ]);
  });

  it("emits a complete event when every screen succeeds", async () => {
    const events: unknown[] = [];
    const screens = [{ id: "one", viewport: VIEWPORT_PRESETS[0]!, page: {} as never }];
    const context = createFlowContext(screens, (event) => events.push(event));
    await context.all("ok", async () => undefined);
    expect(events.at(-1)).toMatchObject({ label: "ok", phase: "complete" });
  });

  it("keeps adversarial strings intact as escaped literals in generated sources", () => {
    const envelope = (action: Action): ActionEnvelope => ActionEnvelopeSchema.parse({
      actionId: 1,
      documentGeneration: 0,
      sourcePaneId: "pane-1",
      action,
      recordedAtUnixMs: 0,
    });
    const adversarial = [
      'quote " terminated',
      "back\\slash",
      "line1\nline2",
      "${process.exitCode = 1}",
      "` + (() => { throw new Error(\"template breakout\"); })() + `",
    ];
    const source = serializeFlow([
      ...adversarial.map((value, index) => envelope({ kind: "fill", locator: { kind: "label", value: `field-${index}` }, value })),
      envelope({ kind: "click", locator: { kind: "role", role: "but\"ton", name: "${name}" } }),
    ]);
    for (const [index, value] of adversarial.entries()) {
      // Eval-free contract: each input appears exactly as JSON.stringify emits it.
      expect(source).toContain(`await page.getByLabel("field-${index}", { exact: true }).fill(${JSON.stringify(value)});`);
    }
    const { diagnostics } = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } });
    expect(diagnostics).toEqual([]);
  });
});
