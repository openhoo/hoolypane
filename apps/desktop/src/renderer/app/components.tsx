import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { ChromeCommand, ChromeState, PaneState } from "@hoolypane/contracts";
import { customViewport } from "./state.js";
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
type LayoutMode = ChromeState["layout"];

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
      class={`${narrow ? "hidden @[200px]:inline-flex" : "inline-flex"} size-5 shrink-0 items-center justify-center rounded focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:text-mute/60 disabled:bg-transparent ${
        danger
          ? "text-mute hover:bg-danger/15 hover:text-danger"
          : active
            ? "bg-accent/15 text-accent hover:bg-accent/25"
            : "text-mute hover:bg-ink/10 hover:text-ink"
      }`}
    >
      {children}
    </button>
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
      <header class="flex h-9 shrink-0 items-center gap-2 border-b border-edge bg-panel px-2">
      <div class="flex shrink-0 items-center gap-1.5 pr-0.5">
        <span aria-hidden="true" class="size-4 rounded-[5px] bg-accent" />
        <span class="whitespace-nowrap text-[13px] font-semibold tracking-tight">Hoolypane</span>
      </div>
      <label class="flex shrink-0 items-center gap-1 text-xs text-mute">
        <span class="sr-only">Layout</span>
        {/* Native select (combobox role): keeps "Focus"/"Horizontal"/"Grid" out of the button
            role namespace so pinned per-pane button lookups stay unambiguous. */}
        <select
          id="layout"
          value={state.layout}
          onChange={(event) => send({ kind: "set-layout", layout: (event.currentTarget as HTMLSelectElement).value as LayoutMode })}
          class="h-7 rounded-md border border-edge bg-field px-1 text-xs text-ink outline-none focus:border-accent"
        >
          <option value="grid">Grid</option>
          <option value="horizontal">Horizontal</option>
          <option value="focus">Focus</option>
        </select>
      </label>
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
          onInput={(event) => onAddressInput((event.currentTarget as HTMLInputElement).value)}
          class="h-7 w-full rounded-md border border-edge bg-field px-2.5 text-[13px] text-ink outline-none placeholder:text-mute/70 focus:border-accent"
        />
      </form>
      <button
        type="button"
        onClick={() => send({ kind: "create", viewport: customViewport(960, 720) })}
        class="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-edge bg-field px-2 text-xs font-medium text-ink hover:bg-elevated focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
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
        class={`flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent hover:bg-ink/10 ${
          state.syncEnabled ? "text-ink" : "text-mute"
        }`}
      >
        <span aria-hidden="true" class={`relative h-3.5 w-6 rounded-full transition-colors ${state.syncEnabled ? "bg-accent" : "bg-edge"}`}>
          <span class={`absolute top-0.5 size-2.5 rounded-full transition-all ${state.syncEnabled ? "left-3 bg-canvas" : "left-0.5 bg-mute"}`} />
        </span>
        Sync
      </button>
      <button
        type="button"
        aria-pressed={state.recording}
        onClick={() => send({ kind: state.recording ? "record-stop" : "record-start" })}
        class={`flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-semibold focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
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

/** Plain-text pane name (visible in body.innerText); double-click switches to an inline rename input. */
function PaneName({ pane, onRename }: { pane: PaneState; onRename(name: string): void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pane.name);
  useEffect(() => {
    if (!editing) setDraft(pane.name);
  }, [editing, pane.name]);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== pane.name) onRename(trimmed);
    setEditing(false);
  };
  if (!editing) {
    return (
      <span
        title="Double-click to rename"
        onDblClick={() => setEditing(true)}
        class="min-w-4 flex-1 cursor-text truncate rounded px-0.5 text-xs font-semibold text-ink hover:bg-ink/5"
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
        if ((event as KeyboardEvent).key === "Enter") (event.currentTarget as HTMLInputElement).blur();
        if ((event as KeyboardEvent).key === "Escape") setEditing(false);
      }}
      onInput={(event) => setDraft((event.currentTarget as HTMLInputElement).value)}
      class="min-w-6 max-w-36 shrink rounded bg-field px-0.5 text-xs font-semibold text-ink outline-none focus:border-accent"
    />
  );
}

export function PaneCard({
  pane,
  focused,
  closable,
  hidden,
  placement,
  zoom,
  send,
}: {
  pane: PaneState;
  focused: boolean;
  closable: boolean;
  hidden: boolean;
  /** Absolute workspace position; absent before the first layout measurement. */
  placement?: { x: number; y: number; width: number; height: number };
  zoom?: number;
  send: SendCommand;
}) {
  return (
    <article
      style={placement ? { position: "absolute", left: placement.x, top: placement.y, width: placement.width, height: placement.height } : undefined}
      class={`pane-card @container relative flex min-w-0 select-none flex-col overflow-hidden rounded-lg border shadow-lg shadow-black/25 ${
        focused ? "focused ring-2 ring-accent ring-offset-0" : ""
      } ${hidden ? "hidden" : "border-edge hover:border-accent/40"}`}
    >
      {pane.loading && (
        <div aria-hidden="true" class="absolute inset-x-0 top-0 z-10 h-0.5 animate-pulse bg-accent" />
      )}
      <header class="flex h-7 shrink-0 items-center border-b border-edge bg-elevated pl-1 pr-1">
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
          {pane.viewport.width}×{pane.viewport.height} @{pane.viewport.deviceScaleFactor}x
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
      <div data-pane-surface={pane.id} aria-label={`${pane.name} browser surface`} class="relative min-h-0 flex-1 overflow-hidden bg-canvas">
        <span class="pointer-events-none absolute left-1 top-1 select-none font-mono text-[10px] text-mute/80">{pane.url}</span>
      </div>
    </article>
  );
}

export function ErrorToast({ message }: { message: string }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (dismissed === message) return null;
  return (
    <div
      role="alert"
      class="fixed bottom-2 right-2 z-50 flex max-w-sm items-start gap-2 rounded-lg border border-danger/50 bg-panel px-3 py-2 shadow-lg shadow-black/40"
    >
      <IconAlertTriangle class="mt-0.5 text-danger" />
      <p class="min-w-0 break-words text-xs text-ink">{message}</p>
      <IconButton label="Dismiss error" danger onClick={() => setDismissed(message)}>
        <IconClose />
      </IconButton>
    </div>
  );
}
