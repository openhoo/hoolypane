import { ipcRenderer } from "electron";
import { IPC_CHANNELS, PaneGenerationSchema, PaneObservedActionSchema, ReplayRequestSchema, type Action, type LocatorSpec, type ReplayRequest, type ReplayResult } from "@hoolypane/contracts";

let documentGeneration = 0;
const suppressed = new Map<number, number>(); // actionId → documentGeneration the action was resolved against
let pendingFill: { element: HTMLInputElement | HTMLTextAreaElement; timer: number } | undefined;
let scrollFrame = 0;

function normalizedText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function elementsFor(locator: LocatorSpec): Element[] {
  switch (locator.kind) {
    case "testId": return [...document.querySelectorAll(`[data-testid=${CSS.escape(locator.value)}]`)];
    case "role": return [...document.querySelectorAll("[role],button,a,input,select,textarea")].filter((element) => roleFor(element) === locator.role && accessibleName(element) === locator.name);
    case "label": return [...document.querySelectorAll("label")].filter((label) => normalizedText(label.textContent) === locator.value).flatMap((label) => {
      const control = (label as HTMLLabelElement).control;
      return control ? [control] : [];
    });
    case "placeholder": return [...document.querySelectorAll("input[placeholder],textarea[placeholder]")].filter((element) => element.getAttribute("placeholder") === locator.value);
    case "text": return [...document.querySelectorAll("button,a,label,[role],p,span,h1,h2,h3,h4,h5,h6")].filter((element) => normalizedText(element.textContent) === locator.value);
    case "css": return [...document.querySelectorAll(locator.value)];
  }
}

function roleFor(element: Element): string {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit;
  if (element instanceof HTMLButtonElement) return "button";
  if (element instanceof HTMLAnchorElement && element.href) return "link";
  if (element instanceof HTMLSelectElement) return "combobox";
  if (element instanceof HTMLTextAreaElement) return "textbox";
  if (element instanceof HTMLInputElement) {
    if (element.type === "checkbox") return "checkbox";
    if (element.type === "radio") return "radio";
    if (["button", "submit", "reset"].includes(element.type)) return "button";
    return "textbox";
  }
  return "";
}

function accessibleName(element: Element): string {
  const aria = element.getAttribute("aria-label");
  if (aria) return normalizedText(aria);
  if (element instanceof HTMLInputElement && element.labels?.length) return normalizedText([...element.labels].map((label) => label.textContent).join(" "));
  if (element instanceof HTMLInputElement && element.type === "password") return "";
  return normalizedText(element.textContent || element.getAttribute("title") || (element as HTMLInputElement).value);
}

function unique(locator: LocatorSpec): boolean {
  try { return elementsFor(locator).length === 1; } catch { return false; }
}

function cssPath(element: Element): string {
  if (element === document.documentElement) return "html";
  if (element.id) {
    const selector = `#${CSS.escape(element.id)}`;
    if (document.querySelectorAll(selector).length === 1) return selector;
  }
  const segments: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.documentElement) {
    const parent: Element | null = current.parentElement;
    const siblings: Element[] = parent ? [...parent.children].filter((candidate) => candidate.tagName === current!.tagName) : [];
    const suffix = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
    segments.unshift(`${current.tagName.toLowerCase()}${suffix}`);
    current = parent;
  }
  return `html > ${segments.join(" > ")}`;
}

function locatorFor(element: Element): LocatorSpec {
  const testId = element.getAttribute("data-testid");
  if (testId && unique({ kind: "testId", value: testId })) return { kind: "testId", value: testId };
  const role = roleFor(element);
  const name = accessibleName(element);
  if (role && name && unique({ kind: "role", role, name })) return { kind: "role", role, name };
  if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
    for (const label of element.labels ?? []) {
      const value = normalizedText(label.textContent);
      if (value && unique({ kind: "label", value })) return { kind: "label", value };
    }
    const placeholder = element.getAttribute("placeholder");
    if (placeholder && unique({ kind: "placeholder", value: placeholder })) return { kind: "placeholder", value: placeholder };
  }
  const text = normalizedText(element.textContent);
  if (text && text.length <= 120 && unique({ kind: "text", value: text })) return { kind: "text", value: text };
  const value = cssPath(element);
  if (unique({ kind: "css", value })) return { kind: "css", value };
  throw new Error("interaction target has no unique supported locator");
}

function emit(action: Action): void {
  if (suppressed.size > 0 || window.top !== window) return;
  ipcRenderer.send(IPC_CHANNELS.paneAction, PaneObservedActionSchema.parse({ documentGeneration, action }));
}

function record(action: () => Action): void {
  try { emit(action()); } catch (error) { console.error("[hoolypane] failed to record action", error); }
}

function flushFill(): void {
  if (!pendingFill) return;
  window.clearTimeout(pendingFill.timer);
  const element = pendingFill.element;
  pendingFill = undefined;
  if (!element.isConnected) return;
  record(() => ({ kind: "fill", locator: locatorFor(element), value: element.value }));
}

ipcRenderer.on(IPC_CHANNELS.paneGeneration, (_event, value: unknown) => {
  try {
    const nextGeneration = PaneGenerationSchema.parse(value).documentGeneration;
    for (const [actionId, expectedGeneration] of suppressed) if (expectedGeneration !== nextGeneration) suppressed.delete(actionId);
    documentGeneration = nextGeneration;
  } catch (error) { console.error("[hoolypane] invalid pane generation", error); }
});
window.addEventListener("beforeunload", flushFill);
ipcRenderer.on(IPC_CHANNELS.flush, flushFill);

document.addEventListener("input", (event) => {
  if (!event.isTrusted || suppressed.size > 0) return;
  const element = event.target;
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) || ["checkbox", "radio", "password"].includes(element.type)) return;
  if (pendingFill) window.clearTimeout(pendingFill.timer);
  pendingFill = { element, timer: window.setTimeout(flushFill, 300) };
}, true);
document.addEventListener("blur", (event) => { if (event.target === pendingFill?.element) flushFill(); }, true);
document.addEventListener("change", (event) => {
  if (!event.isTrusted || suppressed.size > 0) return;
  const element = event.target;
  if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) record(() => ({ kind: "check", locator: locatorFor(element), checked: element.checked }));
  else if (element instanceof HTMLSelectElement) record(() => ({ kind: "select", locator: locatorFor(element), values: [...element.selectedOptions].map((option) => option.value) }));
}, true);
document.addEventListener("click", (event) => {
  if (!event.isTrusted) return;
  const suppressedEntry = suppressed.entries().next();
  if (!suppressedEntry.done) {
    const [suppressedActionId, expectedGeneration] = suppressedEntry.value;
    suppressed.delete(suppressedActionId);
    if (expectedGeneration === documentGeneration) {
      ipcRenderer.send(IPC_CHANNELS.replayResult, { actionId: suppressedActionId, phase: "confirm", ok: true } satisfies ReplayResult);
    } else {
      ipcRenderer.send(IPC_CHANNELS.replayResult, { actionId: suppressedActionId, phase: "confirm", ok: false, reason: `stale document generation ${expectedGeneration}, current ${documentGeneration}` } satisfies ReplayResult);
    }
    return;
  }
  const target = event.target instanceof Element ? event.target.closest("button,a,[role],input") : null;
  if (!target || target instanceof HTMLInputElement && ["checkbox", "radio", "text", "email", "search", "url", "number", "password", "tel"].includes(target.type)) return;
  record(() => ({ kind: "click", locator: locatorFor(target) }));
}, true);
document.addEventListener("keydown", (event) => {
  if (!event.isTrusted || suppressed.size > 0 || !["Enter", "Escape", "Tab"].includes(event.key)) return;
  flushFill();
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (event.key === "Enter" && target.closest("button,a")) return;
  record(() => ({ kind: "press", locator: locatorFor(target), key: event.key }));
}, true);
document.addEventListener("scroll", (event) => {
  if (!event.isTrusted || suppressed.size > 0 || scrollFrame) return;
  scrollFrame = window.requestAnimationFrame(() => {
    scrollFrame = 0;
    const target = event.target instanceof HTMLElement ? event.target : document.documentElement;
    const horizontalRatio = target.scrollWidth === target.clientWidth ? 0 : Math.min(1, Math.max(0, target.scrollLeft / (target.scrollWidth - target.clientWidth)));
    const verticalRatio = target.scrollHeight === target.clientHeight ? 0 : Math.min(1, Math.max(0, target.scrollTop / (target.scrollHeight - target.clientHeight)));
    record(() => ({ kind: "scroll", locator: locatorFor(target), horizontalRatio, verticalRatio }));
  });
}, true);

ipcRenderer.on(IPC_CHANNELS.replay, (_event, value: unknown) => {
  let request: ReplayRequest;
  try {
    request = ReplayRequestSchema.parse(value);
  } catch (error) {
    const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const actionId = typeof raw.actionId === "number" && Number.isInteger(raw.actionId) && raw.actionId > 0 ? raw.actionId : 1;
    const phase = raw.phase === "resolve" || raw.phase === "apply-dom" || raw.phase === "end" || raw.phase === "confirm" ? raw.phase : "resolve";
    ipcRenderer.send(IPC_CHANNELS.replayResult, { actionId, phase, ok: false, reason: (error instanceof Error ? error.message : String(error)).slice(0, 512) } satisfies ReplayResult);
    return;
  }
  if (request.phase === "end") suppressed.delete(request.actionId);
  let result: ReplayResult = { actionId: request.actionId, phase: request.phase, ok: true };
  try {
    if (request.documentGeneration !== documentGeneration) throw new Error(`stale document generation ${request.documentGeneration}, current ${documentGeneration}`);
    if (request.phase === "resolve" || request.phase === "apply-dom") {
      if (request.action.kind === "navigate") throw new Error("navigate has no element target");
      const matches = elementsFor(request.action.locator);
      if (matches.length !== 1) throw new Error(`locator resolved ${matches.length} elements`);
      const element = matches[0]!;
      suppressed.set(request.actionId, request.documentGeneration);
      if (request.phase === "resolve" && (request.action.kind === "fill" || request.action.kind === "press") && element instanceof HTMLElement) {
        element.focus({ preventScroll: true });
      }
      if (request.phase === "apply-dom") {
        if (request.action.kind === "select" && element instanceof HTMLSelectElement) {
          const selected = new Set(request.action.values);
          for (const option of element.options) option.selected = selected.has(option.value);
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (request.action.kind === "scroll" && element instanceof HTMLElement) {
          element.scrollTo({ left: request.action.horizontalRatio * Math.max(0, element.scrollWidth - element.clientWidth), top: request.action.verticalRatio * Math.max(0, element.scrollHeight - element.clientHeight) });
          element.dispatchEvent(new Event("scroll", { bubbles: true }));
        }
      }
      const box = element.getBoundingClientRect();
      result = { ...result, box: { x: box.x, y: box.y, width: box.width, height: box.height }, ...(element instanceof HTMLInputElement ? { checked: element.checked } : {}) };
    }
  } catch (error) {
    result = { ...result, ok: false, reason: (error instanceof Error ? error.message : String(error)).slice(0, 512) };
  }
  ipcRenderer.send(IPC_CHANNELS.replayResult, result);
});
