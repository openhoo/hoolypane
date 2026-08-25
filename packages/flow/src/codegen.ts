import { SCROLL_RATIO_MAX, SCROLL_RATIO_MIN, type Action, type ActionEnvelope, type LocatorSpec } from "@hoolypane/contracts";

function literal(value: unknown): string {
  return JSON.stringify(value);
}

export function locatorExpression(locator: LocatorSpec): string {
  switch (locator.kind) {
    case "testId": return `page.getByTestId(${literal(locator.value)})`;
    case "role": return `page.getByRole(${literal(locator.role)}, { name: ${literal(locator.name)}, exact: true })`;
    case "label": return `page.getByLabel(${literal(locator.value)}, { exact: true })`;
    case "placeholder": return `page.getByPlaceholder(${literal(locator.value)}, { exact: true })`;
    case "text": return `page.getByText(${literal(locator.value)}, { exact: true })`;
    case "css": return `page.locator(${literal(locator.value)})`;
  }
}

function actionStatements(action: Action): readonly string[] {
  if (action.kind === "navigate") return [`await page.goto(${literal(action.url)});`];
  const locator = locatorExpression(action.locator);
  switch (action.kind) {
    case "click": return [`await ${locator}.click();`];
    case "fill": return [`await ${locator}.fill(${literal(action.value)});`];
    case "select": return [`await ${locator}.selectOption(${literal(action.values)});`];
    case "check": return [`await ${locator}.${action.checked ? "check" : "uncheck"}();`];
    case "press": return [`await ${locator}.press(${literal(action.key)});`];
    case "scroll": {
      const horizontal = action.horizontalRatio;
      const vertical = action.verticalRatio;
      if (typeof horizontal !== "number" || typeof vertical !== "number" || !Number.isFinite(horizontal) || !Number.isFinite(vertical) || horizontal < SCROLL_RATIO_MIN || horizontal > SCROLL_RATIO_MAX || vertical < SCROLL_RATIO_MIN || vertical > SCROLL_RATIO_MAX) {
        throw new Error(`Invalid scroll ratios: ${String(action.horizontalRatio)}, ${String(action.verticalRatio)}`);
      }
      return [
        `await ${locator}.evaluate((element, ratios) => {`,
        "  const target = element as HTMLElement;",
        "  target.scrollTo({",
        "    left: ratios.horizontal * Math.max(0, target.scrollWidth - target.clientWidth),",
        "    top: ratios.vertical * Math.max(0, target.scrollHeight - target.clientHeight),",
        '    behavior: "instant",',
        "  });",
        `}, { horizontal: ${horizontal}, vertical: ${vertical} });`,
      ];
    }
  }
}

export function serializeFlow(envelopes: readonly ActionEnvelope[]): string {
  const lines = [
    `import { defineFlow } from ${literal("@hoolypane/runner")};`,
    "",
    "export default defineFlow(async ({ all }) => {",
  ];
  for (const envelope of envelopes) {
    const label = `${envelope.actionId}-${envelope.action.kind}`;
    lines.push(`  await all(${literal(label)}, async ({ page }) => {`);
    for (const statement of actionStatements(envelope.action)) lines.push(`    ${statement}`);
    lines.push("  });");
  }
  lines.push("});", "");
  return lines.join("\n");
}
