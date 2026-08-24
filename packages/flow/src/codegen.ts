import type { Action, ActionEnvelope, LocatorSpec } from "@hoolypane/contracts";

function literal(value: unknown): string {
  return JSON.stringify(value);
}

export function locatorExpression(locator: LocatorSpec, page = "page"): string {
  switch (locator.kind) {
    case "testId": return `${page}.getByTestId(${literal(locator.value)})`;
    case "role": return `${page}.getByRole(${literal(locator.role)}, { name: ${literal(locator.name)}, exact: true })`;
    case "label": return `${page}.getByLabel(${literal(locator.value)}, { exact: true })`;
    case "placeholder": return `${page}.getByPlaceholder(${literal(locator.value)}, { exact: true })`;
    case "text": return `${page}.getByText(${literal(locator.value)}, { exact: true })`;
    case "css": return `${page}.locator(${literal(locator.value)})`;
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
      const horizontal = Number(action.horizontalRatio);
      const vertical = Number(action.verticalRatio);
      if (!Number.isFinite(horizontal) || !Number.isFinite(vertical) || horizontal < 0 || horizontal > 1 || vertical < 0 || vertical > 1) {
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

export function serializeFlow(envelopes: readonly ActionEnvelope[], importPath = "@hoolypane/runner"): string {
  const lines = [
    `import { defineFlow } from ${literal(importPath)};`,
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
