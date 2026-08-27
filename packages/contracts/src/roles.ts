/**
 * Roles Playwright's getByRole can actually resolve — kept identical to the installed
 * playwright-core validRoles set by contracts.test.ts. Anything outside this set never matches a
 * getByRole query and would deadlock replay until the flow deadline.
 *
 * Single source of truth shared by both sides of the recording seam:
 * - packages/flow codegen serializes member roles as page.getByRole(...) and falls back to an
 *   explicit [role="..."] attribute selector otherwise;
 * - the desktop preload recorder derives implicit ARIA roles (hoisted here as
 *   RECORDER_IMPLICIT_ROLES, compile-pinned to this table via `satisfies`) and must never emit a
 *   name outside it.
 */
export const GET_BY_ROLE_ROLES = {
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

/**
 * Implicit ARIA roles the desktop preload recorder derives from element semantics
 * (apps/desktop pane.ts roleFor). Canonical witness that GET_BY_ROLE_ROLES covers every role the
 * recorder can emit: contracts.test.ts asserts full table coverage over this list and the
 * preload consumes it directly instead of hand-copying it.
 */
export const RECORDER_IMPLICIT_ROLES = [
  "button", "link", "combobox", "textbox", "checkbox", "radio", "searchbox", "spinbutton", "slider",
] as const satisfies readonly (keyof typeof GET_BY_ROLE_ROLES)[];
