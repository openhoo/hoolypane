import { SCROLL_RATIO_MAX, SCROLL_RATIO_MIN, type Action, type ActionEnvelope, type LocatorSpec } from "@hoolypane/contracts";

function literal(value: unknown): string {
  return JSON.stringify(value);
}

/** Roles Playwright's getByRole can actually resolve (playwright-core validRoles); anything else never matches and would deadlock replay until the flow deadline. */
const GET_BY_ROLE_ROLES = {
  alert: true, alertdialog: true, application: true, article: true, banner: true, blockquote: true, button: true, caption: true,
  cell: true, checkbox: true, code: true, columnheader: true, combobox: true, complementary: true, contentinfo: true, definition: true,
  deletion: true, dialog: true, directory: true, document: true, emphasis: true, feed: true, figure: true, form: true, generic: true,
  grid: true, gridcell: true, group: true, heading: true, img: true, insertion: true, link: true, list: true, listbox: true,
  listitem: true, log: true, main: true, mark: true, marquee: true, math: true, meter: true, menu: true, menubar: true,
  menuitem: true, menuitemcheckbox: true, menuitemradio: true, navigation: true, none: true, note: true, option: true,
  paragraph: true, presentation: true, progressbar: true, radio: true, radiogroup: true, region: true, row: true, rowgroup: true,
  rowheader: true, scrollbar: true, search: true, searchbox: true, separator: true, slider: true, spinbutton: true, status: true,
  strong: true, subscript: true, superscript: true, switch: true, tab: true, table: true, tablist: true, tabpanel: true,
  term: true, textbox: true, time: true, timer: true, toolbar: true, tooltip: true, tree: true, treegrid: true, treeitem: true,
} as const satisfies Record<string, true>;

/** Locates the recorded explicit role attribute directly; accessible-name matching is intentionally dropped because the recorded step could never have matched anything. */
function roleAttributeSelector(role: string): string {
  const escaped = role.replace(/["\\\u0000-\u001f\u007f]/g, (char) => char === `"` ? `\\"` : char === `\\` ? `\\\\` : `\\${char.charCodeAt(0).toString(16)} `);
  return `[role="${escaped}"]`;
}

export function locatorExpression(locator: LocatorSpec): string {
  switch (locator.kind) {
    case "testId": return `page.getByTestId(${literal(locator.value)})`;
    case "role":
      if (!Object.hasOwn(GET_BY_ROLE_ROLES, locator.role.trim().toLowerCase())) return `page.locator(${literal(roleAttributeSelector(locator.role))})`;
      return `page.getByRole(${literal(locator.role)}, { name: ${literal(locator.name)}, exact: true })`;
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
