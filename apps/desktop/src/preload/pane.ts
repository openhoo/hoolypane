import { ipcRenderer } from "electron";
import { IPC_CHANNELS, PaneGenerationSchema, PaneObservedActionSchema, RecordFailureSchema, ReplayRequestSchema, errorMessage, staleGenerationMessage, type Action, type LocatorSpec, type ReplayRequest, type ReplayResult } from "@hoolypane/contracts";

let documentGeneration = 0;
type SuppressionEntry = { generation: number; kind: Action["kind"]; box?: { x: number; y: number; width: number; height: number }; confirmed?: boolean };
const suppressed = new Map<number, SuppressionEntry>(); // actionId → replay context awaiting its trusted-input echo
// Scroll positions written by replay-driven scrolling (apply-dom scrollTo and scrollIntoView). A
// trusted scroll event landing exactly on such a position is our own echo, never user intent, and
// must never be observed back (it would re-broadcast into every other pane). Events arriving at a
// diverging position consume the entry and are mirrored: the user has taken over. Keyed weakly, so
// entries vanish with their elements and need no timers — unlike a frame-callback-based guard,
// which starves under delayed frames and then swallows genuine user scrolls.
const programmaticScrolls = new WeakMap<Element, { top: number; left: number }>();
function recordProgrammaticScroll(container: Element): void {
  programmaticScrolls.set(container, { top: container.scrollTop, left: container.scrollLeft });
}
function autoScrollCenter(element: Element): void {
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); // instant beats CSS scroll-behavior:smooth — an animated scroll registers its pre-animation position below, and trusted animation events then diverge from it
  // scrollIntoView may move the element itself or any scrollable ancestor; remember each final position.
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth) recordProgrammaticScroll(node);
  }
}
let pendingFill: { element: HTMLInputElement | HTMLTextAreaElement; timer: number } | undefined;
// Containers awaiting their end-of-frame position read, paired with whether the gesture that
// queued them was a user takeover (forced past active suppression; pure echoes obey it). One
// shared rAF drains the whole queue so a gesture touching several containers records every one
// of them, not just the first.
const pendingScrollTargets = new Map<HTMLElement, boolean>();
let pendingScrollFrame = 0;

/** True when the container sits within ±1px of a position this pane scrolled programmatically. */
function isOwnScrollEcho(target: Element, programmed: { top: number; left: number }): boolean {
  return Math.abs(target.scrollTop - programmed.top) <= 1 && Math.abs(target.scrollLeft - programmed.left) <= 1;
}

function drainScrollTargets(): void {
  pendingScrollFrame = 0;
  const targets = [...pendingScrollTargets];
  pendingScrollTargets.clear();
  for (const [target, takeover] of targets) {
    // The end position wins over the gesture that scheduled this frame: a programmatic scroll
    // landing between event and callback is our own echo and must never be mirrored.
    const programmed = programmaticScrolls.get(target);
    if (programmed) {
      programmaticScrolls.delete(target);
      if (isOwnScrollEcho(target, programmed)) continue;
    }
    const horizontalRatio = target.scrollWidth === target.clientWidth ? 0 : Math.min(1, Math.max(0, target.scrollLeft / (target.scrollWidth - target.clientWidth)));
    const verticalRatio = target.scrollHeight === target.clientHeight ? 0 : Math.min(1, Math.max(0, target.scrollTop / (target.scrollHeight - target.clientHeight)));
    // Takeovers emit forced so they survive active suppression; echoes queued before suppression
    // began still fall under the guard.
    record(() => ({ kind: "scroll", locator: locatorFor(target), horizontalRatio, verticalRatio }), takeover);
  }
}

function normalizedText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function elementsFor(locator: LocatorSpec, labelElements?: readonly Element[]): Element[] {
  switch (locator.kind) {
    case "testId": return [...document.querySelectorAll(`[data-testid=${CSS.escape(locator.value)}]`)];
    case "role": return [...document.querySelectorAll("[role],button,a,input,select,textarea")].filter((element) => roleFor(element) === locator.role && accessibleName(element) === locator.name);
    case "label": return [...(labelElements ?? document.querySelectorAll("label"))].filter((label) => normalizedText(label.textContent) === locator.value).flatMap((label) => {
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
  // No .value fallback: a live value is not part of standard accName computation for text fields,
  // and a value-keyed role locator can never resolve in a sibling whose input still shows its old
  // value — recording would flag every mirror outOfSync although placeholder/label/css would resolve.
  return normalizedText(element.textContent || element.getAttribute("title"));
}

function unique(locator: LocatorSpec, labelElements?: readonly Element[]): boolean {
  return elementsFor(locator, labelElements).length === 1;
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
    const labels = element.labels ?? [];
    if (labels.length > 0) {
      // One shared sweep serves every label variant: the DOM cannot mutate between synchronous
      // reads, so the cached list resolves identically to per-variant queries — same winners,
      // same order, strictly fewer full-document traversals.
      const labelElements = [...document.querySelectorAll("label")];
      for (const label of labels) {
        const value = normalizedText(label.textContent);
        if (value && unique({ kind: "label", value }, labelElements)) return { kind: "label", value };
      }
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

function emit(action: Action, force = false): void {
  // Forced emits (unload-time fill flush) bypass suppression on purpose: losing a user-typed value
  // at teardown is worse than racing a replay echo. Iframe panes stay silent either way.
  if ((!force && suppressed.size > 0) || window.top !== window) return;
  ipcRenderer.send(IPC_CHANNELS.paneAction, PaneObservedActionSchema.parse({ documentGeneration, action }));
}

function record(action: () => Action, force = false): void {
  try {
    emit(action(), force);
  } catch (error) {
    console.error("[hoolypane] failed to record action", error);
    // Recording used to fail silently (locator resolution throws routinely); surface it to main.
    // Truncated before parse so the payload is always schema-valid and the send can never throw.
    const reason = errorMessage(error).slice(0, 512);
    ipcRenderer.send(IPC_CHANNELS.recordFailure, RecordFailureSchema.parse({ reason }));
  }
}

function flushFill(force = false): void {
  const pending = pendingFill;
  if (!pending) return;
  // Under active replay suppression emit() would silently discard the fill; keep it pending and
  // flush once the last suppression entry drains (mirrors main's deferredActions design). Only the
  // unload path forces past this guard — a deferred fill must never die with the document.
  if (!force && suppressed.size > 0) return;
  window.clearTimeout(pending.timer);
  const element = pending.element;
  pendingFill = undefined;
  if (!element.isConnected) return;
  record(() => ({ kind: "fill", locator: locatorFor(element), value: element.value }), force);
}

/** Flushes a fill that active suppression had deferred, as soon as the last entry is gone. */
function drainDeferredFill(): void {
  if (suppressed.size === 0) flushFill();
}

/** Frees one suppression slot; the freed slot may unblock a deferred user-typed fill. */
function releaseSuppression(actionId: number): void {
  suppressed.delete(actionId);
  drainDeferredFill();
}

ipcRenderer.on(IPC_CHANNELS.paneGeneration, (_event, value: unknown) => {
  try {
    const nextGeneration = PaneGenerationSchema.parse(value).documentGeneration;
    for (const [actionId, entry] of suppressed) if (entry.generation !== nextGeneration) suppressed.delete(actionId);
    documentGeneration = nextGeneration;
    drainDeferredFill();
  } catch (error) { console.error("[hoolypane] invalid pane generation", error); }
});
window.addEventListener("beforeunload", () => flushFill(true));
// Wrapped so the IPC event object never leaks into flushFill's force parameter.
ipcRenderer.on(IPC_CHANNELS.flush, () => flushFill());

// Local-only control types shared by the fill and click guards below; the click list adds the
// text-like types because clicking into them only focuses a control whose fills already mirror.
const LOCAL_ONLY_FILL_TYPES: readonly string[] = ["checkbox", "radio", "password", "range", "color", "file", "date", "datetime-local", "month", "time", "week"];
const LOCAL_ONLY_CLICK_TYPES: readonly string[] = [...LOCAL_ONLY_FILL_TYPES, "text", "email", "search", "url", "number", "tel"];

document.addEventListener("input", (event) => {
  if (!event.isTrusted || suppressed.size > 0) return;
  const element = event.target;
  // Fill replay applies values via CDP Input.insertText, which only mutates text-like controls:
  // range/color/file and the date/time pickers ignore inserted text, so recording a fill for them
  // would replay as a silent no-op on every mirror while sync reports the panes healthy. Exclude
  // them like password — the gesture stays local instead of claiming a mirrored write that never lands.
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) || LOCAL_ONLY_FILL_TYPES.includes(element.type)) return;
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
  // A trusted click inside the confirm window may only acknowledge the replay whose resolved
  // box contains the click coordinates; anything else is a human click. On a miss every entry
  // is kept and no confirm is sent, so a stray click can never ack the wrong actionId while the
  // real CDP click would fall through unconfirmed as a phantom.
  if (suppressed.size > 0) {
    let matchedActionId: number | undefined;
    let matchedEntry: SuppressionEntry | undefined;
    for (const [actionId, entry] of suppressed) {
      if (entry.confirmed) continue; // a settled check entry may not acknowledge another click while its trailing echo drains
      const box = entry.box;
      // check toggles land as the same trusted click — main drives CDP mouseDown/mouseUp and
      // awaits this confirm exactly like for click. Without admitting them the confirm promise
      // times out after 5s and marks the pane outOfSync although the toggle itself landed.
      if (!box || (entry.kind !== "click" && entry.kind !== "check")) continue;
      if (event.clientX >= box.x - 2 && event.clientX <= box.x + box.width + 2 && event.clientY >= box.y - 2 && event.clientY <= box.y + box.height + 2) {
        matchedActionId = actionId;
        matchedEntry = entry;
        break;
      }
    }
    if (!matchedActionId || !matchedEntry) return; // human click during the confirm window: keep entries, send no confirm
    // A mirrored check's trailing trusted input+change events fire only AFTER this click dispatch
    // completes (the control's activation behavior runs post-dispatch), so deleting the entry here
    // let them observe empty suppression and re-record the mirrored toggle as a fresh user check.
    // Marking the entry confirmed keeps suppression alive for exactly one macrotask — long enough
    // to swallow the trailing events (radio groups emit change on the deselected sibling too),
    // while a confirmed entry can never acknowledge a second click — then the slot frees.
    if (matchedEntry.kind === "check") {
      matchedEntry.confirmed = true;
      const settledActionId = matchedActionId;
      window.setTimeout(() => releaseSuppression(settledActionId), 0);
    } else {
      releaseSuppression(matchedActionId);
    }
    if (matchedEntry.generation === documentGeneration) {
      ipcRenderer.send(IPC_CHANNELS.replayResult, { actionId: matchedActionId, phase: "confirm", ok: true } satisfies ReplayResult);
    } else {
      ipcRenderer.send(IPC_CHANNELS.replayResult, { actionId: matchedActionId, phase: "confirm", ok: false, reason: staleGenerationMessage(matchedEntry.generation, documentGeneration) } satisfies ReplayResult);
    }
    return;
  }
  const target = event.target instanceof Element ? event.target.closest("button,a,[role],input") : null;
  // range/color/file and the date/time pickers are local-only for fills (see the input listener):
  // the trusted click ending their gesture (slider drag commit, picker toggle) stays local too, or
  // main mirrors a center-click that drags every sibling's slider while no fill ever reconciles it.
  if (!target || target instanceof HTMLInputElement && LOCAL_ONLY_CLICK_TYPES.includes(target.type)) return;
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
  if (!event.isTrusted) return;
  const target = event.target;
  // Echo reconciliation must run before every other guard: an entry left unconsumed here would
  // linger past the suppression window and later swallow a genuine user scroll landing exactly
  // on the recorded position.
  let takeover = false;
  if (target instanceof Element) {
    const programmed = programmaticScrolls.get(target);
    if (programmed) {
      programmaticScrolls.delete(target);
      // An echo lands exactly where the replay scrolled; a diverging position means the user moved it.
      takeover = !isOwnScrollEcho(target, programmed);
      if (!takeover) return;
    }
  }
  // Document-level scrolls are viewport management, and replay-driven auto-scrolls are our own
  // doing — recording either would mirror them back into all other panes as phantom user actions.
  if (!(target instanceof HTMLElement) || target === document.documentElement || target === document.body) return;
  // A user takeover survives suppression and coalescing alike; only pure echoes may be dropped
  // by suppression. Everything else queues onto the one shared frame, which reads every queued
  // container's terminal position.
  if (!takeover && suppressed.size > 0) return;
  pendingScrollTargets.set(target, (pendingScrollTargets.get(target) ?? false) || takeover);
  if (pendingScrollFrame) return;
  pendingScrollFrame = window.requestAnimationFrame(drainScrollTargets);
}, true);

ipcRenderer.on(IPC_CHANNELS.replay, (_event, value: unknown) => {
  let request: ReplayRequest;
  try {
    request = ReplayRequestSchema.parse(value);
  } catch (error) {
    const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const actionId = typeof raw.actionId === "number" && Number.isInteger(raw.actionId) && raw.actionId > 0 ? raw.actionId : 1;
    const phase = raw.phase === "resolve" || raw.phase === "apply-dom" || raw.phase === "end" || raw.phase === "confirm" ? raw.phase : "resolve";
    ipcRenderer.send(IPC_CHANNELS.replayResult, { actionId, phase, ok: false, reason: errorMessage(error).slice(0, 512) } satisfies ReplayResult);
    return;
  }
  if (request.phase === "end") releaseSuppression(request.actionId);
  let result: ReplayResult = { actionId: request.actionId, phase: request.phase, ok: true };
  try {
    if (request.documentGeneration !== documentGeneration) throw new Error(staleGenerationMessage(request.documentGeneration, documentGeneration));
    if (request.phase === "resolve" || request.phase === "apply-dom") {
      if (request.action.kind === "navigate") throw new Error("navigate has no element target");
      const matches = elementsFor(request.action.locator);
      if (matches.length !== 1) throw new Error(`locator resolved ${matches.length} elements`);
      const element = matches[0]!;
      // A drifted locator resolving to exactly one element of the wrong kind must fail loudly:
      // falling through reported ok:true while applying nothing, so main counted a diverging pane
      // as in-sync and never flagged outOfSync. Validated before the suppression entry is armed,
      // mirroring the other hard failures in this handler.
      if (request.phase === "apply-dom") {
        if (request.action.kind === "select" && !(element instanceof HTMLSelectElement)) throw new Error("select locator resolved a non-select element");
        if (request.action.kind === "scroll" && !(element instanceof HTMLElement)) throw new Error("scroll locator resolved a non-HTMLElement");
      }
      const entry: SuppressionEntry = { generation: request.documentGeneration, kind: request.action.kind };
      suppressed.set(request.actionId, entry);
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
          element.scrollTo({ left: request.action.horizontalRatio * Math.max(0, element.scrollWidth - element.clientWidth), top: request.action.verticalRatio * Math.max(0, element.scrollHeight - element.clientHeight), behavior: "instant" });
          recordProgrammaticScroll(element);
          element.dispatchEvent(new Event("scroll", { bubbles: true }));
        }
      }
      // Mirrored native input is routed at viewport coordinates: bring the target into view first,
      // exactly like a real user (or Playwright's auto-scroll) would, before measuring its box.
      // Only click/check/fill/press qualify: select/scroll apply via DOM writes alone, and
      // centering them would mutate ancestor scroll positions the recording never captured.
      if (request.action.kind === "click" || request.action.kind === "check" || request.action.kind === "fill" || request.action.kind === "press") {
        autoScrollCenter(element);
      }
      const box = element.getBoundingClientRect();
      entry.box = { x: box.x, y: box.y, width: box.width, height: box.height };
      result = { ...result, box: { x: box.x, y: box.y, width: box.width, height: box.height }, ...(element instanceof HTMLInputElement ? { checked: element.checked } : {}) };
    }
  } catch (error) {
    result = { ...result, ok: false, reason: errorMessage(error).slice(0, 512) };
  }
  ipcRenderer.send(IPC_CHANNELS.replayResult, result);
});
