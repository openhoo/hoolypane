import { memo } from "preact/compat";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { ChromeCommand, ChromeState, ColorSchemeMode, LayoutMode, OverlayKey, PaneState, ThrottlingMode } from "@hoolypane/contracts";
import { formatViewportDimensions } from "@hoolypane/contracts";
import { customViewport } from "./state.js";
import { PANE_HEADER_HEIGHT } from "./layout.js";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowRight,
  IconCamera,
  IconClose,
  IconFocus,
  IconImage,
  IconPlus,
  IconReload,
  IconRotate,
  IconUnfocus,
} from "./icons.js";

export type SendCommand = (command: ChromeCommand) => void;

const OVERLAY_LABELS = {
  outlines: "Outlines",
  disableImages: "Disable images",
  showRoles: "Show roles",
} satisfies Record<OverlayKey, string>;

const OVERLAY_ITEMS = Object.entries(OVERLAY_LABELS).map(([key, label]) => ({ key: key as OverlayKey, label }));
// Same exhaustive-table derivation as toolbarOptions below; kept separate because menu items are keyed, not valued.

// Option tables derive from the contract unions: adding or renaming a mode fails compilation
// here instead of drifting into hand-synced literals rejected only at runtime by main's zod.
const toolbarOptions = <K extends string>(labels: Record<K, string>): readonly { value: K; label: string }[] =>
  // Sole string-to-union boundary for the toolbar selects; every caller's table is satisfies-pinned to its contract union.
  Object.keys(labels).map((key): { value: K; label: string } => ({ value: key as K, label: labels[key as K] }));

const LAYOUT_OPTIONS = toolbarOptions({
  free: "Free",
  grid: "Grid",
  horizontal: "Horizontal",
  focus: "Focus",
} satisfies Record<LayoutMode, string>);

const COLOR_SCHEME_OPTIONS = toolbarOptions({
  auto: "Auto",
  light: "Light",
  dark: "Dark",
} satisfies Record<ColorSchemeMode, string>);

const THROTTLING_OPTIONS = toolbarOptions({
  none: "No throttling",
  slow3g: "Slow 3G",
  offline: "Offline",
} satisfies Record<ThrottlingMode, string>);

const selectClass = (active: boolean, padding = "px-1"): string =>
  `h-8 rounded-lg border bg-field ${padding} text-xs text-ink outline-none transition-colors focus:border-accent/70 ${active ? "border-accent/70" : "border-edge"}`;

const fieldTone = (active: boolean): string => (active ? "border-accent/70 bg-accent/15 text-accent-text" : "border-edge bg-field text-mute hover:text-ink");

const dotTone = (on: boolean): string => `size-1.5 shrink-0 rounded-full ${on ? "bg-accent" : "bg-edge"}`;

const focusRing = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

function IconButton({
  label,
  onClick,
  disabled,
  danger,
  active,
  narrow,
  children,
}: {
  label: string;
  onClick(): void;
  disabled?: boolean;
  danger?: boolean;
  active?: boolean;
  /** Hidden inside cards narrower than 200px to keep the pane name readable. */
  narrow?: boolean;
  children: ComponentChildren;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      class={`${narrow ? "hidden @[200px]:inline-flex" : "inline-flex"} size-5 shrink-0 items-center justify-center rounded transition-colors ${focusRing} disabled:pointer-events-none disabled:text-mute/60 disabled:bg-transparent ${
        danger
          ? "text-mute hover:bg-danger/15 hover:text-danger"
          : active
            ? "bg-accent/15 text-accent-text hover:bg-accent/25"
            : "text-mute hover:bg-ink/10 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

// Shared markup for the toolbar's three option selects: wrapper label, optional leading
// indicator slot, the find-guarded change mapping, and the shared selectClass surface.
function ToolbarSelect<K extends string>({
  options,
  value,
  active,
  labelClass,
  selectId,
  ariaLabel,
  padding,
  leading,
  onSelect,
}: {
  options: readonly { value: K; label: string }[];
  value: K;
  active: boolean;
  labelClass: string;
  selectId?: string;
  ariaLabel?: string;
  padding?: string;
  leading?: ComponentChildren;
  onSelect(value: K): void;
}) {
  return (
    <label class={labelClass}>
      {leading}
      <select
        id={selectId}
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => {
          const selected = options.find((option) => option.value === event.currentTarget.value);
          if (selected) onSelect(selected.value);
        }}
        class={selectClass(active, padding)}
      >
        {options.map(({ value: optionValue, label }) => (
          <option key={optionValue} value={optionValue}>{label}</option>
        ))}
      </select>
    </label>
  );
}

export function Toolbar({
  state,
  address,
  onAddressInput,
  onAddressFocus,
  onAddressBlur,
  onSubmitUrl,
  send,
}: {
  state: ChromeState;
  address: string;
  onAddressInput(value: string): void;
  onAddressFocus(): void;
  onAddressBlur(): void;
  onSubmitUrl(event: SubmitEvent): void;
  send: SendCommand;
}) {
  return (
    <>
      <header class="flex min-h-10 flex-wrap shrink-0 items-center gap-2.5 border-b border-edge bg-panel px-3 py-1">
      <div class="flex shrink-0 items-center gap-1.5 pr-0.5">
        <span aria-hidden="true" class="size-4 rounded-[6px] bg-gradient-to-br from-accent to-cyan-400" />
        <span class="whitespace-nowrap text-[13px] font-semibold tracking-tight">Hoolypane</span>
      </div>
      {/* Native select (combobox role): keeps "Focus"/"Horizontal"/"Grid" out of the button
          role namespace so pinned per-pane button lookups stay unambiguous. */}
      <ToolbarSelect
        options={LAYOUT_OPTIONS}
        value={state.layout}
        active={false}
        labelClass="flex shrink-0 items-center gap-1 text-xs text-mute"
        selectId="layout"
        padding="px-1.5"
        leading={<span class="sr-only">Layout</span>}
        onSelect={(layout) => send({ kind: "set-layout", layout })}
      />
      <form class="mx-1 flex min-w-32 flex-1" onSubmit={onSubmitUrl}>
        <label for="address" class="sr-only">Address</label>
        <input
          id="address"
          type="text"
          spellcheck={false}
          autocomplete="off"
          value={address}
          placeholder="https://example.com"
          onFocus={onAddressFocus}
          onBlur={onAddressBlur}
          onInput={(event) => onAddressInput(event.currentTarget.value)}
          class="h-8 w-full rounded-lg border border-edge bg-field px-3 text-[13px] text-ink outline-none transition-colors placeholder:text-mute/60 focus:border-accent/70"
        />
      </form>
      <button
        type="button"
        onClick={() => send({ kind: "create", viewport: customViewport(960, 720) })}
        class={`flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-edge bg-elevated px-2 text-xs font-medium text-ink hover:bg-field ${focusRing}`}
      >
        <IconPlus class="text-accent" />
        Add custom
      </button>
      <IconButton label="Save Overview PNG" onClick={() => send({ kind: "capture-overview" })}>
        <IconImage />
      </IconButton>
      <button
        type="button"
        role="switch"
        aria-checked={state.syncEnabled}
        aria-label="Sync"
        onClick={() => send({ kind: "set-sync", enabled: !state.syncEnabled })}
        class={`flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs ${focusRing} hover:bg-ink/10 ${
          state.syncEnabled ? "text-ink" : "text-mute"
        }`}
      >
        <span aria-hidden="true" class={`relative h-3.5 w-6 rounded-full transition-colors ${state.syncEnabled ? "bg-accent" : "bg-edge"}`}>
          <span class={`absolute top-0.5 size-2.5 rounded-full transition-all ${state.syncEnabled ? "left-3 bg-canvas" : "left-0.5 bg-mute"}`} />
        </span>
        Sync
      </button>
      <div role="group" aria-label="Emulation" class="flex h-8 shrink-0 items-center gap-1 border-l border-edge pl-2">
        <ToolbarSelect
          options={COLOR_SCHEME_OPTIONS}
          value={state.emulation.colorScheme}
          active={state.emulation.colorScheme !== "auto"}
          labelClass="flex items-center gap-1"
          ariaLabel="Color scheme"
          leading={<span aria-hidden="true" class={dotTone(state.emulation.colorScheme !== "auto")} />}
          onSelect={(value) => send({ kind: "set-color-scheme", value })}
        />
        <button
          type="button"
          aria-pressed={state.emulation.reducedMotion}
          aria-label="Reduced motion"
          title="Reduced motion"
          onClick={() => send({ kind: "set-reduced-motion", enabled: !state.emulation.reducedMotion })}
          class={`h-8 shrink-0 whitespace-nowrap rounded-lg border px-2 text-xs transition-colors ${focusRing} ${fieldTone(state.emulation.reducedMotion)}`}
        >
          Motion
        </button>
        <ToolbarSelect
          options={THROTTLING_OPTIONS}
          value={state.emulation.throttling}
          active={state.emulation.throttling !== "none"}
          labelClass="flex items-center gap-1"
          ariaLabel="Throttling"
          leading={<span aria-hidden="true" class={dotTone(state.emulation.throttling !== "none")} />}
          onSelect={(mode) => send({ kind: "set-throttling", mode })}
        />
        <details class="relative">
          <summary
            aria-label="Overlays"
            class={`flex h-8 shrink-0 cursor-pointer list-none items-center gap-1 whitespace-nowrap rounded-lg border px-2 text-xs transition-colors [&::-webkit-details-marker]:hidden ${fieldTone(
              OVERLAY_ITEMS.some((item) => state.emulation.overlays[item.key]),
            )}`}
          >
            Overlays
          </summary>
          <div role="menu" aria-label="Overlays" class="absolute right-0 top-9 z-40 flex w-36 flex-col rounded-lg border border-edge bg-elevated p-1 shadow-xl">
            {OVERLAY_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitemcheckbox"
                aria-checked={state.emulation.overlays[item.key]}
                onClick={(event) => {
                  send({ kind: "set-overlay", key: item.key, enabled: !state.emulation.overlays[item.key] });
                  event.currentTarget.closest("details")?.removeAttribute("open");
                }}
                class="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs text-ink hover:bg-field"
              >
                {item.label}
                <span aria-hidden="true" class={dotTone(state.emulation.overlays[item.key])} />
              </button>
            ))}
          </div>
        </details>
      </div>
      <button
        type="button"
        aria-pressed={state.recording}
        onClick={() => send({ kind: state.recording ? "record-stop" : "record-start" })}
        class={`flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-xs font-semibold ${focusRing} ${
          state.recording
            ? "border border-danger/60 bg-danger/15 text-danger hover:bg-danger/25"
            : "border border-edge bg-field text-ink hover:border-accent/50 hover:bg-elevated"
        }`}
      >
        <span aria-hidden="true" class={`size-2 rounded-full ${state.recording ? "animate-pulse bg-danger" : "bg-mute"}`} />
        {state.recording ? "Stop Flow Recording" : "Start Flow Recording"}
      </button>
      </header>
      {state.recording && <div aria-hidden="true" class="h-0.5 shrink-0 animate-pulse bg-danger" />}
    </>
  );
}

/** Plain-text pane name; double-click or press Enter/F2/Space to switch to an inline rename input. */
function PaneName({ pane, onRename }: { pane: PaneState; onRename(name: string): void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pane.name);
  const nameRef = useRef<HTMLSpanElement>(null);
  // Armed when editing ends via keyboard (Enter/Escape): the input unmounts while still holding
  // focus, so hand focus back to the restored name span instead of letting it drop to <body>.
  const restoreFocusRef = useRef(false);
  useEffect(() => {
    if (!editing) setDraft(pane.name);
  }, [editing, pane.name]);
  useEffect(() => {
    if (editing || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    nameRef.current?.focus();
  }, [editing]);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== pane.name) onRename(trimmed);
    setEditing(false);
  };
  if (!editing) {
    return (
      <span
        ref={nameRef}
        title="Double-click or press Enter/F2/Space to rename"
        data-pane-name=""
        role="button"
        tabIndex={0}
        aria-label={`Rename ${pane.name}`}
        onDblClick={() => setEditing(true)}
        onKeyDown={(event) => {
          // The name control owns its keys: neither the header delegate (closest("button,
          // input, select") never matches this span) nor any other guard stops Enter/F2
          // here, so stopPropagation is the only thing keeping rename keys from arming
          // keyboard-move. Other keys still bubble so an armed keyboard-move session keeps
          // handling its bindings while this span holds focus.
          const key = event.key;
          if (key === "Enter" || key === "F2" || key === " ") {
            event.stopPropagation();
            event.preventDefault();
            setEditing(true);
          }
        }}
        class={`min-w-4 flex-1 cursor-text truncate rounded px-0.5 text-xs font-semibold text-ink hover:bg-ink/5 ${focusRing}`}
      >
        {pane.name}
      </span>
    );
  }
  return (
    <input
      aria-label="Name"
      autoFocus
      value={draft}
      onBlur={commit}
      onKeyDown={(event) => {
        // Same ownership rule as the name span: rename keys must never reach the header
        // delegate or the global keyboard-move listener.
        event.stopPropagation();
        if (event.key === "Enter") {
          restoreFocusRef.current = true;
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          restoreFocusRef.current = true;
          setEditing(false);
        }
      }}
      onInput={(event) => setDraft(event.currentTarget.value)}
      class="min-w-6 max-w-36 shrink rounded border border-edge bg-field px-0.5 text-xs font-semibold text-ink outline-none focus:border-accent"
    />
  );
}

export const PaneCard = memo(function PaneCard({
  pane,
  focused,
  closable,
  hidden,
  placement,
  zoom,
  dragging,
  onHeaderPointerDown,
  onHeaderKeyDown,
  send,
}: {
  pane: PaneState;
  focused: boolean;
  closable: boolean;
  hidden: boolean;
  /** Absolute workspace position; absent before the first layout measurement. */
  placement?: { x: number; y: number; width: number; height: number };
  zoom?: number;
  dragging?: boolean;
  onHeaderKeyDown?: (event: KeyboardEvent) => void;
  onHeaderPointerDown?: (event: PointerEvent) => void;
  send: SendCommand;
}) {
  return (
    <article
      style={placement ? { position: "absolute", left: placement.x, top: placement.y, width: placement.width, height: placement.height } : undefined}
      class={`pane-card @container relative flex min-w-0 select-none flex-col overflow-hidden rounded-xl border shadow-xl shadow-black/30 transition-shadow ${
        focused ? "focused ring-2 ring-accent" : ""
      } ${dragging ? "z-30 scale-[1.01] border-accent/60 shadow-black/50" : ""} ${hidden ? "hidden" : dragging ? "" : "border-edge ring-1 ring-white/[0.04] hover:border-accent/40"}`}
    >
      {pane.loading && (
        <div aria-hidden="true" class="absolute inset-x-0 top-0 z-10 h-0.5 animate-pulse bg-accent" />
      )}
      <header
        data-pane-header=""
        data-pane-id={pane.id}
        tabIndex={0}
        aria-label={`${pane.name} pane header`}
        onPointerDown={(event) => { const target = event.target as HTMLElement; if (target.closest("button, input, select") || target.closest("[data-pane-name]")) return; event.preventDefault(); onHeaderPointerDown?.(event); }}
        onKeyDown={(event) => { const target = event.target as HTMLElement; if (target.closest("button, input, select")) return; onHeaderKeyDown?.(event); }}
        style={{ height: PANE_HEADER_HEIGHT }}
        class={`flex shrink-0 cursor-grab items-center gap-0.5 border-b border-edge bg-elevated pl-1 pr-1 ${focusRing} active:cursor-grabbing ${dragging ? "bg-field" : ""}`}
      >
        <PaneName pane={pane} onRename={(name) => send({ kind: "rename", paneId: pane.id, name })} />
        {pane.failure && (
          <p role="alert" title={pane.failure} class="min-w-0 truncate rounded bg-danger/15 px-1.5 leading-4 text-[11px] text-danger">
            {pane.failure}
          </p>
        )}
        {pane.outOfSync && (
          <span
            role="alert"
            title={`${pane.outOfSync.actionKind} #${pane.outOfSync.actionId}: ${pane.outOfSync.reason}`}
            class="shrink-0 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning"
          >
            out of sync
          </span>
        )}
        <span aria-hidden="true" class="ml-auto hidden shrink-0 items-center gap-1.5 font-mono text-[10px] text-mute @[240px]:flex">
          {formatViewportDimensions(pane.viewport)}
          {zoom !== undefined && zoom < 0.995 && (
            <span class="rounded bg-ink/10 px-1 leading-4">{Math.round(zoom * 100)}%</span>
          )}
        </span>
        <IconButton narrow label="Back" disabled={!pane.canGoBack} onClick={() => send({ kind: "back", paneId: pane.id })}>
          <IconArrowLeft />
        </IconButton>
        <IconButton narrow label="Forward" disabled={!pane.canGoForward} onClick={() => send({ kind: "forward", paneId: pane.id })}>
          <IconArrowRight />
        </IconButton>
        <IconButton label="Reload" onClick={() => send({ kind: "reload", paneId: pane.id })}>
          <IconReload />
        </IconButton>
        <IconButton label="Rotate" onClick={() => send({ kind: "rotate", paneId: pane.id })}>
          <IconRotate />
        </IconButton>
        <IconButton label={focused ? "Unfocus" : "Focus"} active={focused} onClick={() => send({ kind: "focus", paneId: focused ? null : pane.id })}>
          {focused ? <IconUnfocus /> : <IconFocus />}
        </IconButton>
        <IconButton label="Save PNG" onClick={() => send({ kind: "capture-pane", paneId: pane.id })}>
          <IconCamera />
        </IconButton>
        <IconButton label="Close" danger disabled={!closable} onClick={() => send({ kind: "close", paneId: pane.id })}>
          <IconClose />
        </IconButton>
      </header>
      {/* Placeholder for the native WebContentsView overlay; measured via getBoundingClientRect for bounds emission. */}
      <div data-pane-surface={pane.id} class="relative min-h-0 flex-1 overflow-hidden bg-canvas">
        <span class="pointer-events-none absolute left-1 top-1 select-none font-mono text-[10px] text-mute/80">{pane.url}</span>
      </div>
    </article>
  );
});

export function ErrorToast({ message }: { message: string }) {
  const [dismissedMessage, setDismissedMessage] = useState<string | null>(null);
  const [lastMessage, setLastMessage] = useState(message);
  const toastRef = useRef<HTMLDivElement | null>(null);
  if (message !== lastMessage) {
    // A different error arrived: forget the dismissal so the new toast shows even when an
    // identical earlier message was already dismissed within this mount streak.
    setLastMessage(message);
    setDismissedMessage(null);
  }
  if (dismissedMessage === message) return null;
  return (
    <div ref={toastRef}
      role="alert"
      class="toast-enter fixed bottom-2 right-2 z-50 flex max-w-sm items-start gap-2 rounded-xl border border-danger/50 bg-panel px-3 py-2 shadow-xl shadow-black/40"
    >
      <IconAlertTriangle class="mt-0.5 text-danger" />
      <p class="min-w-0 break-words text-xs text-ink">{message}</p>
      <IconButton
        label="Dismiss error"
        danger
        onClick={() => {
          // Restore focus to the address bar before the toast unmounts under the pointer.
          const active = document.activeElement;
          if (active instanceof Node && toastRef.current?.contains(active)) document.getElementById("address")?.focus();
          setDismissedMessage(message);
        }}
      >
        <IconClose />
      </IconButton>
    </div>
  );
}
