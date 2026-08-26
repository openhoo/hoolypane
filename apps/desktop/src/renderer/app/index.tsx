import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type StateUpdater } from "preact/hooks";
import { render } from "preact";
import { ChromeStateSchema, type ChromeState, type PanePosition } from "@hoolypane/contracts";
import { ErrorToast, PaneCard, Toolbar, type SendCommand } from "./components.js";
import { installDevMock } from "./devMock.js";
import { chromeReducer, initialChromeState } from "./state.js";
import { clampPanePosition, computePaneTiles, LAYOUT_PADDING, type PaneTile } from "./layout.js";
import "../styles.css";

const SNAP_PX = 8;
const SURFACE_SELECTOR = "[data-pane-surface]";
const INGRESS_RETRY_LIMIT = 3;
const INGRESS_RETRY_DELAY_MS = 150;

type RefBox<T> = { current: T };
type ChromeDispatch = (action: Parameters<typeof chromeReducer>[1]) => void;

function rect(element: HTMLElement) {
  const value = element.getBoundingClientRect();
  const x = Math.max(0, Math.min(window.innerWidth, Math.round(value.x)));
  const y = Math.max(0, Math.min(window.innerHeight, Math.round(value.y)));
  const right = Math.max(x, Math.min(window.innerWidth, Math.round(value.right)));
  const bottom = Math.max(y, Math.min(window.innerHeight, Math.round(value.bottom)));
  return { x, y, width: right - x, height: bottom - y };
}

function nearestSnap(pre: number, extent: number, candidates: readonly number[]): { value: number; guide: number } | null {
  let best: { value: number; guide: number; distance: number } | null = null;
  for (const candidate of candidates) {
    const startDistance = Math.abs(pre - candidate);
    if (startDistance <= SNAP_PX && (best === null || startDistance < best.distance)) best = { value: candidate, guide: candidate, distance: startDistance };
    const endDistance = Math.abs(pre + extent - candidate);
    if (endDistance <= SNAP_PX && (best === null || endDistance < best.distance)) best = { value: candidate - extent, guide: candidate, distance: endDistance };
  }
  return best;
}

/** Pure free-drag placement: padded-domain clamp, one nearest-edge snap per axis, then the post-snap re-clamp. */
function snappedDragPosition(
  paneId: string,
  pointerX: number,
  pointerY: number,
  offsetX: number,
  offsetY: number,
  tiles: ReadonlyMap<string, PaneTile>,
  width: number,
  height: number,
): { x: number; y: number; guideX: number | null; guideY: number | null } {
  const dragged = tiles.get(paneId);
  const cardWidth = dragged?.width ?? 0;
  const cardHeight = dragged?.height ?? 0;
  let x = clampPanePosition(Math.round(pointerX - offsetX), width, cardWidth);
  let y = clampPanePosition(Math.round(pointerY - offsetY), height, cardHeight);
  // Automatic alignment: snap the dragged card's edges to sibling edges within SNAP_PX.
  // Exactly ONE candidate per axis wins — the nearest edge match judged against the PRE-snap
  // value — so matches can no longer compound last-match-wins style.
  const snapXs: number[] = [LAYOUT_PADDING, width - LAYOUT_PADDING - cardWidth];
  const snapYs: number[] = [LAYOUT_PADDING, height - LAYOUT_PADDING - cardHeight];
  for (const sibling of tiles.values()) {
    if (sibling.id === paneId || sibling.hidden) continue;
    snapXs.push(sibling.x, sibling.x + sibling.width);
    snapYs.push(sibling.y, sibling.y + sibling.height);
  }
  const snappedX = nearestSnap(x, cardWidth, snapXs);
  const snappedY = nearestSnap(y, cardHeight, snapYs);
  if (snappedX) x = snappedX.value;
  if (snappedY) y = snappedY.value;
  // Post-snap re-clamp through the same padded clamp as restore/keyboard so committed drag
  // positions round-trip without restoreFreePositions rewriting them on next launch.
  x = clampPanePosition(x, width, cardWidth);
  y = clampPanePosition(y, height, cardHeight);
  return { x, y, guideX: snappedX?.guide ?? null, guideY: snappedY?.guide ?? null };
}

// Arrows typed into an editable (address bar, rename input) must never nudge the pane or
// lose caret handling: callers bail before any keyboard-move handling or preventDefault runs.
function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)
  );
}

/** Per-arrow nudge step at the shared snap increment, or null for any non-nudge key. */
function arrowNudgeDelta(key: string): { dx: number; dy: number } | null {
  switch (key) {
    case "ArrowLeft":
      return { dx: -SNAP_PX, dy: 0 };
    case "ArrowRight":
      return { dx: SNAP_PX, dy: 0 };
    case "ArrowUp":
      return { dx: 0, dy: -SNAP_PX };
    case "ArrowDown":
      return { dx: 0, dy: SNAP_PX };
    default:
      return null;
  }
}

/**
 * Imperative shell of a free-layout pointer drag, extracted verbatim from usePaneGestures'
 * startPaneDrag: installs the window-level move/up/cancel trio, tracks the gesture, commits
 * exactly one move-pane on release, and tears down on every exit path. Every former closure
 * capture arrives explicitly via deps.
 */
function beginFreeDragGesture(
  paneId: string,
  event: PointerEvent,
  deps: {
    tilesRef: RefBox<Map<string, PaneTile>>;
    layoutRef: RefBox<ChromeState["layout"]>;
    workspaceRef: RefBox<HTMLElement | null>;
    requestEmit: RefBox<() => void>;
    endDragRef: RefBox<(() => void) | null>;
    wasDraggingRef: RefBox<boolean>;
    cancelKeyboardMove(): void;
    setDrag: (update: StateUpdater<{ id: string; x: number; y: number } | null>) => void;
    setGuides: (update: StateUpdater<{ x: number | null; y: number | null }>) => void;
    send: SendCommand;
  },
): void {
  // Dragging rearranges stored free positions; in generated layouts a header gesture must
  // neither move panes nor persist a move-pane command. A live drag is detected via
  // endDragRef, which flips synchronously at listener install — drag state is async-batched.
  if (deps.endDragRef.current || deps.layoutRef.current !== "free") return;
  deps.cancelKeyboardMove();
  const tile = deps.tilesRef.current.get(paneId);
  if (!tile || tile.hidden || event.button !== 0) return;
  const offsetX = event.clientX - tile.x;
  const offsetY = event.clientY - tile.y;
  // Only a real pointer movement turns the gesture into a move-pane; a bare header click
  // must not persist anything or it would freeze the masonry seed in place.
  let moved = false;
  let lastPlaced: { x: number; y: number } | null = null;

  const move = (moveEvent: PointerEvent): void => {
    moved = true;
    const currentTiles = deps.tilesRef.current;
    // The workspace extent is re-read every frame so resizes mid-drag are honored;
    // clientWidth/clientHeight is the single metric source (no border-box mix).
    const width = deps.workspaceRef.current?.clientWidth ?? 0;
    const height = deps.workspaceRef.current?.clientHeight ?? 0;
    const placed = snappedDragPosition(paneId, moveEvent.clientX, moveEvent.clientY, offsetX, offsetY, currentTiles, width, height);
    lastPlaced = { x: placed.x, y: placed.y };
    deps.setGuides((prev) => (prev.x === placed.guideX && prev.y === placed.guideY ? prev : { x: placed.guideX, y: placed.guideY }));
    deps.setDrag((prev) => (prev !== null && prev.id === paneId && prev.x === placed.x && prev.y === placed.y ? prev : { id: paneId, x: placed.x, y: placed.y }));
    // The native WebContentsView follows the card only when main receives fresh bounds.
    // requestEmit coalesces via snapshotPending: at most one IPC per animation frame.
    deps.requestEmit.current();
  };
  // Shared end path for pointerup AND pointercancel so an interrupted gesture can never
  // strand listeners or guides; unmount reuses it via endDragRef.
  const end = (): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    deps.endDragRef.current = null;
    // A layout switch mid-gesture must not commit a stale free-position payload.
    const layoutStillFree = deps.layoutRef.current === "free";
    // Updaters stay pure: commit from gesture locals and send outside setState, so
    // exactly-once delivery never depends on how often a queued updater is invoked.
    deps.setDrag(null);
    if (moved && layoutStillFree && lastPlaced) {
      deps.send({ kind: "move-pane", paneId, x: lastPlaced.x, y: lastPlaced.y });
    }
    deps.setGuides({ x: null, y: null });
    // Final emission is deferred: the drag===null effect below waits out the revert render
    // (double-rAF) so bounds are measured from settled DOM, not from the last dragged frame.
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
  deps.endDragRef.current = end;
  deps.wasDraggingRef.current = true;
  deps.setDrag({ id: paneId, x: tile.x, y: tile.y });
}

function useAddressState(initialUrl: string, send: SendCommand) {
  const [address, setAddress] = useState(initialUrl);
  const latestSharedUrl = useRef(initialUrl);
  const addressFocused = useRef(false);
  const addressDirty = useRef(false);
  const handleAddressInput = useCallback((value: string): void => {
    addressDirty.current = true;
    setAddress(value);
  }, []);
  const navigate = (event: SubmitEvent) => {
    event.preventDefault();
    const url = address.trim();
    if (!url) return;
    send({ kind: "navigate", url });
  };
  const blurAddress = () => {
    addressFocused.current = false;
    if (!addressDirty.current) return;
    window.setTimeout(() => {
      if (addressFocused.current) return;
      addressDirty.current = false;
      setAddress(latestSharedUrl.current);
    }, 0);
  };
  return { address, setAddress, latestSharedUrl, addressFocused, addressDirty, handleAddressInput, navigate, blurAddress };
}

function useWorkspaceMeasure(workspaceRef: RefBox<HTMLElement | null>) {
  const [workspaceSize, setWorkspaceSize] = useState({ width: 0, height: 0 });
  const workspaceSizeRef = useRef(workspaceSize);
  workspaceSizeRef.current = workspaceSize;
  useEffect(() => {
    const section = workspaceRef.current;
    if (!section) return;
    const measure = () => setWorkspaceSize({ width: section.clientWidth, height: section.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(section);
    return () => observer.disconnect();
  }, []);
  return { workspaceSize, workspaceSizeRef };
}

function useChromeIngest(
  dispatch: ChromeDispatch,
  setAddress: (value: string) => void,
  stateReceived: RefBox<boolean>,
  latestSharedUrl: RefBox<string>,
  addressFocused: RefBox<boolean>,
  addressDirty: RefBox<boolean>,
  requestEmit: RefBox<() => void>,
) {
  useEffect(() => {
    const chrome = window.hoolypaneChrome;
    let unsubscribe: (() => void) | null = null;
    let retryTimer: number | undefined;
    let failures = 0;
    let disposed = false;
    // Ingress validation failure: the pushed snapshot is unusable, so pull a fresh one by
    // re-installing the subscription (each subscribe() invocation performs the preload's
    // stateRequest pull). Bounded retries; past the limit a visible lastError replaces the old
    // silent freeze.
    const ingest = (value: unknown): void => {
      const parsed = ChromeStateSchema.safeParse(value);
      if (!parsed.success) {
        console.error("[hoolypane] rejected chrome state", parsed.error.message);
        if (disposed) return;
        if (failures >= INGRESS_RETRY_LIMIT) {
          window.clearTimeout(retryTimer);
          unsubscribe?.();
          unsubscribe = null;
          dispatch({ type: "error", message: "Live state updates kept failing validation; live sync paused." });
          return;
        }
        failures += 1;
        window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(() => {
          if (disposed || !window.hoolypaneChrome) return;
          unsubscribe?.();
          unsubscribe = window.hoolypaneChrome.subscribe(ingest);
        }, INGRESS_RETRY_DELAY_MS * failures);
        return;
      }
      failures = 0;
      window.clearTimeout(retryTimer);
      retryTimer = undefined;
      const next = parsed.data;
      const firstSnapshot = !stateReceived.current;
      stateReceived.current = true;
      latestSharedUrl.current = next.sharedUrl;
      dispatch({ type: "state", state: next });
      if (!addressFocused.current && !addressDirty.current) setAddress(next.sharedUrl);
      if (firstSnapshot) requestEmit.current();
    };
    unsubscribe = chrome.subscribe(ingest);
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      unsubscribe?.();
    };
  }, []);
}

// Keyboard-move mode owns its gesture state wholesale: arrows nudge stored free positions
// (persisted per step via move-pane), Enter ends the session, Escape restores. Split out of
// the pointer-drag hook below; the only coupling is endDragRef (a live pointer drag blocks
// arming) plus the shared refs and layout prop.
function useKeyboardMoveMode({
  tilesRef,
  layoutRef,
  endDragRef,
  workspaceRef,
  layout,
  send,
}: {
  tilesRef: RefBox<Map<string, PaneTile>>;
  layoutRef: RefBox<ChromeState["layout"]>;
  endDragRef: RefBox<(() => void) | null>;
  workspaceRef: RefBox<HTMLElement | null>;
  layout: ChromeState["layout"];
  send: SendCommand;
}) {
  const [keyboardMove, setKeyboardMove] = useState<{ id: string; x: number; y: number } | null>(null);
  const keyboardMoveRef = useRef<{ id: string; x: number; y: number } | null>(null);
  keyboardMoveRef.current = keyboardMove;
  const kbOriginRef = useRef<{ x: number; y: number } | null>(null);
  const startKeyboardMove = useCallback((paneId: string): void => {
    // Mirrors startPaneDrag: keyboard moves rearrange stored free positions, so they must
    // not arm in generated layouts where a move-pane command would freeze masonry seeds.
    if (keyboardMoveRef.current) return;
    if (endDragRef.current || layoutRef.current !== "free") return;
    const tile = tilesRef.current.get(paneId);
    if (!tile || tile.hidden) return;
    kbOriginRef.current = { x: tile.x, y: tile.y };
    setKeyboardMove({ id: paneId, x: tile.x, y: tile.y });
  }, []);
  const cancelKeyboardMove = useCallback((): void => setKeyboardMove(null), []);

  // Keyboard-move mode: arrows nudge by snap increments and persist each step immediately;
  // Enter ends the session, Escape restores the origin. Pointer drag behavior is untouched.
  const kbActive = keyboardMove !== null;
  useEffect(() => {
    if (!kbActive) return;
    const onKey = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target)) return;
      const current = keyboardMoveRef.current;
      if (!current) return;
      const tile = tilesRef.current.get(current.id);
      if (!tile || tile.hidden) {
        setKeyboardMove(null);
        return;
      }
      const delta = arrowNudgeDelta(event.key);
      if (delta !== null) {
        const width = workspaceRef.current?.clientWidth ?? 0;
        const height = workspaceRef.current?.clientHeight ?? 0;
        // Nudges use the same padded-domain clamp as free-tile restore (clampPanePosition); an
        // unclamped gutter commit desyncs the rendered card from the native view's click target.
        const x = clampPanePosition(Math.round(current.x + delta.dx), width, tile.width);
        const y = clampPanePosition(Math.round(current.y + delta.dy), height, tile.height);
        if (x !== current.x || y !== current.y) {
          setKeyboardMove({ id: current.id, x, y });
          send({ kind: "move-pane", paneId: current.id, x, y });
        }
      } else if (event.key === "Enter") {
        setKeyboardMove(null);
      } else if (event.key === "Escape") {
        setKeyboardMove(null);
        const origin = kbOriginRef.current;
        // Same changed-position guard as the arrow branch: restoring an untouched session
        // would only clear lastError and dismiss an unacknowledged error toast.
        if (origin && (origin.x !== current.x || origin.y !== current.y)) {
          send({ kind: "move-pane", paneId: current.id, x: origin.x, y: origin.y });
        }
      } else {
        return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kbActive]);

  // A layout switch mid-move would leave the free-position override pinned over generated
  // tiles; disarm so a dead mode neither renders dragging chrome nor keeps emitting move-pane.
  useEffect(() => {
    if (layout !== "free") setKeyboardMove(null);
  }, [layout]);

  return { keyboardMove, cancelKeyboardMove, startKeyboardMove };
}

function usePaneGestures(
  tiles: Map<string, PaneTile>,
  layout: ChromeState["layout"],
  workspaceRef: RefBox<HTMLElement | null>,
  requestEmit: RefBox<() => void>,
  send: SendCommand,
) {
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;
  const wasDraggingRef = useRef(false);
  // Shared teardown so an unmount mid-drag cannot strand window listeners or guides.
  const endDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => endDragRef.current?.(), []);
  const { keyboardMove, cancelKeyboardMove, startKeyboardMove } = useKeyboardMoveMode({
    tilesRef,
    layoutRef,
    endDragRef,
    workspaceRef,
    layout,
    send,
  });
  const startPaneDrag = useCallback((paneId: string, event: PointerEvent): void => {
    beginFreeDragGesture(paneId, event, {
      tilesRef,
      layoutRef,
      workspaceRef,
      requestEmit,
      endDragRef,
      wasDraggingRef,
      cancelKeyboardMove,
      setDrag,
      setGuides,
      send,
    });
  }, []);

  // Final emit after a gesture: defer until the reverted render has settled (double-rAF).
  useEffect(() => {
    if (drag !== null || !wasDraggingRef.current) return;
    wasDraggingRef.current = false;
    let tail = 0;
    const head = requestAnimationFrame(() => {
      tail = requestAnimationFrame(() => requestEmit.current());
    });
    return () => {
      cancelAnimationFrame(head);
      cancelAnimationFrame(tail);
    };
  }, [drag]);

  // Stable per-card header handlers: pane identity comes from data-pane-id on the header
  // element, so memoized PaneCards never observe a fresh callback identity.
  const onHeaderPointerDown = useCallback(
    (event: PointerEvent) => {
      const paneId = (event.currentTarget as HTMLElement).dataset.paneId;
      if (paneId) startPaneDrag(paneId, event);
    },
    [startPaneDrag],
  );
  const onHeaderKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      const paneId = (event.currentTarget as HTMLElement).dataset.paneId;
      if (paneId) startKeyboardMove(paneId);
    },
    [startKeyboardMove],
  );
  return { drag, keyboardMove, guides, onHeaderPointerDown, onHeaderKeyDown };
}

function useBoundsEmission(
  workspaceSizeRef: RefBox<{ width: number; height: number }>,
  stateReceived: RefBox<boolean>,
  snapshotPending: RefBox<boolean>,
  requestEmit: RefBox<() => void>,
  expectedSurfaceCount: RefBox<number>,
  order: readonly string[],
  layout: ChromeState["layout"],
  positions: Readonly<Record<string, PanePosition>>,
) {
  const orderKey = order.join("\u0000");
  const positionsKey = layout === "free" ? JSON.stringify(positions) : "";
  const observerRef = useRef<ResizeObserver | null>(null);
  // Long-lived emission plumbing, installed once: resize/scroll drive requestEmit directly so a
  // ticking workspaceSize never rebuilds observers.
  useEffect(() => {
    let frame = 0;
    const emit = () => {
      snapshotPending.current = false;
      // Pre-measurement frames would carry all-zero bounds; the observer re-fires once the
      // workspace has a real extent.
      if (!(workspaceSizeRef.current.width > 0 && workspaceSizeRef.current.height > 0)) return;
      const surfaces = [...document.querySelectorAll<HTMLElement>(SURFACE_SELECTOR)];
      // A snapshot missing panes would fail the main-side validation; wait until every pane card
      // exists (post-measurement) before emitting.
      if (surfaces.length !== expectedSurfaceCount.current || surfaces.length === 0) return;
      window.hoolypaneChrome.sendBounds({
        windowWidth: Math.max(1, Math.round(window.innerWidth)),
        windowHeight: Math.max(1, Math.round(window.innerHeight)),
        panes: surfaces.map((element) => ({ paneId: element.dataset.paneSurface ?? "", bounds: rect(element) })),
      });
    };
    const request = () => {
      if (!stateReceived.current || snapshotPending.current) return;
      snapshotPending.current = true;
      frame = requestAnimationFrame(emit);
    };
    requestEmit.current = request;
    const observer = new ResizeObserver(request);
    observerRef.current = observer;
    window.addEventListener("resize", request);
    window.addEventListener("scroll", request, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      snapshotPending.current = false;
      observer.disconnect();
      observerRef.current = null;
      requestEmit.current = () => {};
      window.removeEventListener("resize", request);
      window.removeEventListener("scroll", request, true);
    };
  }, []);
  // Observe exactly the mounted surface set; membership only changes with order/layout identity.
  useEffect(() => {
    const observer = observerRef.current;
    if (!observer) return;
    observer.disconnect();
    document.querySelectorAll<HTMLElement>(SURFACE_SELECTOR).forEach((element) => observer.observe(element));
    requestEmit.current();
  }, [orderKey, layout]);
  // Pure position echoes (move-pane round-trips) resize nothing: request explicitly so the
  // corrective emission measures the settled layout.
  useEffect(() => {
    requestEmit.current();
  }, [positionsKey]);
}

function useFocusRestoration(order: readonly string[]) {
  const focusAnchorRef = useRef<{ id: string; element: HTMLElement } | null>(null);
  const orderRef = useRef(order);
  // Focus restoration net: remember the last focused pane header; when its pane leaves the order
  // while focus sits on a now-detached node, move focus to the next remaining header in reading
  // order, else the address bar.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent): void => {
      const header = (event.target as HTMLElement | null)?.closest?.("[data-pane-header]");
      focusAnchorRef.current =
        header instanceof HTMLElement && header.dataset.paneId ? { id: header.dataset.paneId, element: header } : null;
    };
    window.addEventListener("focusin", onFocusIn);
    return () => window.removeEventListener("focusin", onFocusIn);
  }, []);
  useEffect(() => {
    const previous = orderRef.current;
    if (previous === order) return;
    orderRef.current = order;
    const anchor = focusAnchorRef.current;
    if (!anchor || anchor.element.isConnected) return;
    if (!previous.includes(anchor.id) || order.includes(anchor.id)) return;
    const startIndex = previous.indexOf(anchor.id);
    const candidates = [...previous.slice(startIndex + 1), ...previous.slice(0, startIndex)];
    for (const candidateId of candidates) {
      if (!order.includes(candidateId)) continue;
      const header = document.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(candidateId)}"][data-pane-header]`);
      if (header && !header.closest(".pane-card")?.classList.contains("hidden")) {
        header.focus();
        return;
      }
    }
    document.getElementById("address")?.focus();
  }, [order]);
}

function App({ usingDevMock }: { usingDevMock: boolean }) {
  const [state, dispatch] = useReducer(chromeReducer, undefined, initialChromeState);
  const snapshotPending = useRef(false);
  const stateReceived = useRef(false);
  const requestEmit = useRef<() => void>(() => {});
  const expectedSurfaceCount = useRef(0);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const send = useCallback<SendCommand>((command) => window.hoolypaneChrome.send(command), []);
  const {
    address,
    setAddress,
    latestSharedUrl,
    addressFocused,
    addressDirty,
    handleAddressInput,
    navigate,
    blurAddress,
  } = useAddressState(state.sharedUrl, send);
  const { workspaceSize, workspaceSizeRef } = useWorkspaceMeasure(workspaceRef);
  useChromeIngest(dispatch, setAddress, stateReceived, latestSharedUrl, addressFocused, addressDirty, requestEmit);
  const orderedPanes = useMemo(
    () =>
      state.order
        .map((paneId) => state.panes.find((candidate) => candidate.id === paneId))
        .filter((pane) => pane !== undefined),
    [state.order, state.panes],
  );
  const tiles = useMemo(
    () =>
      computePaneTiles(
        state.layout,
        workspaceSize.width,
        workspaceSize.height,
        orderedPanes.map((pane) => ({ id: pane.id, viewportWidth: pane.viewport.width, viewportHeight: pane.viewport.height })),
        state.focusedPaneId,
        state.layout === "free" ? state.positions : {},
      ),
    [state.layout, workspaceSize.width, workspaceSize.height, orderedPanes, state.focusedPaneId, state.positions],
  );
  expectedSurfaceCount.current = orderedPanes.length;
  const { drag, keyboardMove, guides, onHeaderPointerDown, onHeaderKeyDown } = usePaneGestures(
    tiles,
    state.layout,
    workspaceRef,
    requestEmit,
    send,
  );
  useBoundsEmission(
    workspaceSizeRef,
    stateReceived,
    snapshotPending,
    requestEmit,
    expectedSurfaceCount,
    state.order,
    state.layout,
    state.positions,
  );
  useFocusRestoration(state.order);
  return (
    <main class="flex h-screen w-screen flex-col overflow-hidden bg-canvas font-sans text-[13px] text-ink">
      <Toolbar
        state={state}
        address={address}
        onAddressInput={handleAddressInput}
        onAddressFocus={() => { addressFocused.current = true; }}
        onAddressBlur={blurAddress}
        onSubmitUrl={navigate}
        send={send}
      />
      <section
        ref={workspaceRef}
        aria-label="Browser panes"
        className="relative min-h-0 flex-1 overflow-auto"
        style={{ padding: LAYOUT_PADDING }}
      >
        {orderedPanes.map((pane) => {
          const baseTile = tiles.get(pane.id);
          const override =
            (drag !== null && drag.id === pane.id ? drag : null) ??
            (keyboardMove !== null && keyboardMove.id === pane.id ? keyboardMove : null);
          const tile = override
            ? { ...(baseTile ?? { id: pane.id, zoom: 1, width: 0, height: 0 }), x: override.x, y: override.y }
            : baseTile;
          return (
            <PaneCard
              key={pane.id}
              pane={pane}
              focused={state.focusedPaneId === pane.id}
              closable={state.order.length > 1}
              dragging={override !== null}
              onHeaderPointerDown={onHeaderPointerDown}
              onHeaderKeyDown={onHeaderKeyDown}
              {...(tile !== undefined && tile.hidden !== true ? { placement: tile, zoom: tile.zoom } : {})}
              hidden={tile === undefined || tile.hidden === true}
              send={send}
            />
          );
        })}
        {guides.x !== null && (
          <div aria-hidden="true" class="pointer-events-none absolute inset-y-0 z-20 w-px bg-accent/70" style={{ left: guides.x }} />
        )}
        {guides.y !== null && (
          <div aria-hidden="true" class="pointer-events-none absolute inset-x-0 z-20 h-px bg-accent/70" style={{ top: guides.y }} />
        )}
      </section>
      <footer class="flex h-6 shrink-0 items-center justify-between border-t border-edge bg-panel px-2 text-[10px] text-mute">
        <span>{state.order.length} panes · {state.layout}{state.recording ? " · recording" : ""}</span>
        <span>AGPL-3.0-only · source accompanies this application</span>
      </footer>
      {state.lastError && <ErrorToast message={state.lastError} />}
      {usingDevMock && (
        <div class="fixed bottom-2 left-2 z-50 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-warning">
          dev mock
        </div>
      )}
    </main>
  );
}

const appRoot = document.getElementById("app")!;
const usingDevMock = !window.hoolypaneChrome;
if (usingDevMock) {
  if (import.meta.env.DEV) {
    // DEV MOCK: plain-browser preview without the Electron preload bridge.
    // Never active in production builds.
    installDevMock();
    render(<App usingDevMock />, appRoot);
  } else {
    appRoot.textContent = "Hoolypane requires its Electron preload bridge.";
  }
} else {
  render(<App usingDevMock={false} />, appRoot);
}
