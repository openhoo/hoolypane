import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "preact/hooks";
import { render } from "preact";
import { ChromeStateSchema, type ChromeCommand, type PanePosition } from "@hoolypane/contracts";
import { ErrorToast, PaneCard, Toolbar, type SendCommand } from "./components.js";
import { installDevMock } from "./devMock.js";
import { chromeReducer, initialChromeState, type ChromeState } from "./state.js";
import "../styles.css";

const LAYOUT_PADDING = 8;
const LAYOUT_GAP = 8;
const PANE_HEADER_HEIGHT = 28;
const SNAP_PX = 8;
const SURFACE_SELECTOR = "[data-pane-surface]";
const INGRESS_RETRY_LIMIT = 3;
const INGRESS_RETRY_DELAY_MS = 150;

interface PaneTile {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Content scale the emulation will apply; shown as a zoom chip when below 100%. */
  readonly zoom: number;
  /** Zero-size marker for focus-layout siblings; their cards stay mounted but invisible. */
  readonly hidden?: boolean;
}

interface TileInput {
  readonly id: string;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

function tileFor(input: TileInput, cellWidth: number, cellHeight: number, x: number, y: number): PaneTile {
  // cellHeight is the FULL card extent (header included): clamping zoom against the content area
  // keeps height-clamped cards exactly filling the cell, so centering never yields a negative
  // offset (the old math pushed cards above the padding origin, e.g. y=-6 in focus layout).
  const contentHeight = Math.max(0, cellHeight - PANE_HEADER_HEIGHT);
  const zoom = Math.max(0, Math.min(1, cellWidth / input.viewportWidth, contentHeight / input.viewportHeight));
  const width = Math.round(input.viewportWidth * zoom);
  const height = Math.round(PANE_HEADER_HEIGHT + input.viewportHeight * zoom);
  return {
    id: input.id,
    x: Math.round(x + Math.max(0, (cellWidth - width) / 2)),
    y: Math.round(y + Math.max(0, (cellHeight - height) / 2)),
    width,
    height,
    zoom,
  };
}

/**
 * Tiles panes proportionally to their viewport aspect ratios (Polypane-style): cards are sized to the
 * scaled viewport instead of uniform grid cells, so a 1440×900 desktop site never shares cell
 * dimensions with a 390×844 phone. The grid column count maximizes covered area, which also degrades
 * gracefully in small tiled windows. Every pane receives an entry: focus-mode siblings get explicit
 * zero-size hidden tiles so their cards stay mounted and the bounds contract holds.
 */
function computePaneTiles(
  layout: ChromeState["layout"],
  areaWidth: number,
  areaHeight: number,
  panes: readonly TileInput[],
  focusedPaneId: string | null,
  positions: Readonly<Record<string, PanePosition>> = {},
): Map<string, PaneTile> {
  const tiles = new Map<string, PaneTile>();
  const innerWidth = areaWidth - LAYOUT_PADDING * 2;
  const innerHeight = areaHeight - LAYOUT_PADDING * 2;
  if (innerWidth <= 0 || innerHeight <= 0 || panes.length === 0) return tiles;
  if (layout === "focus") {
    const visible = focusedPaneId === null ? panes[0] : panes.find((pane) => pane.id === focusedPaneId) ?? panes[0];
    if (visible) tiles.set(visible.id, tileFor(visible, innerWidth, innerHeight, LAYOUT_PADDING, LAYOUT_PADDING));
    // Explicit zero-size entries keep sibling cards mounted so surfaces.length always matches
    // expectedSurfaceCount and bounds emission never stalls.
    for (const pane of panes) {
      if (visible !== undefined && pane.id === visible.id) continue;
      tiles.set(pane.id, { id: pane.id, x: 0, y: 0, width: 0, height: 0, zoom: 1, hidden: true });
    }
    return tiles;
  }
  if (layout === "horizontal") {
    const contentHeight = innerHeight - PANE_HEADER_HEIGHT;
    // Height-fit zoom per pane, then a uniform fit so the row cannot overflow the workspace:
    // window-truncated rects would collapse emulation scale for clipped edge panes.
    const heightZoom = (pane: TileInput): number => Math.max(0, Math.min(1, contentHeight / pane.viewportHeight));
    const rowWidth =
      panes.reduce((sum, pane) => sum + pane.viewportWidth * heightZoom(pane), 0) + LAYOUT_GAP * (panes.length - 1);
    const fit = Math.min(1, innerWidth / Math.max(1, rowWidth));
    let x = LAYOUT_PADDING;
    for (const pane of panes) {
      const zoom = heightZoom(pane) * fit;
      const width = Math.round(pane.viewportWidth * zoom);
      tiles.set(pane.id, tileFor(pane, width, innerHeight, x, LAYOUT_PADDING));
      x += width + LAYOUT_GAP;
    }
    return tiles;
  }
  // Column masonry (Polypane-style): cards keep their viewport aspect ratio at a shared column
  // width, and each card is placed in the currently shortest column. This packs mixed landscape/
  // portrait viewports without row-band dead space; the whole arrangement scales down only when it
  // overshoots the workspace height.
  let bestCoverage = -1;
  let bestPlacement: PaneTile[] = [];
  for (let columns = 1; columns <= panes.length; columns += 1) {
    const cellWidth = (innerWidth - LAYOUT_GAP * (columns - 1)) / columns;
    if (cellWidth <= 0) continue;
    const widthZoom = (pane: TileInput): number => Math.min(1, cellWidth / pane.viewportWidth);
    const columnHeights: number[] = Array.from({ length: columns }, () => LAYOUT_PADDING);
    const placement: PaneTile[] = [];
    for (const pane of panes) {
      const zoom = widthZoom(pane);
      const width = Math.round(pane.viewportWidth * zoom);
      const height = Math.round(PANE_HEADER_HEIGHT + pane.viewportHeight * zoom);
      let shortest = 0;
      let shortestHeight = Number.POSITIVE_INFINITY;
      for (const [index, current] of columnHeights.entries()) {
        if (current < shortestHeight) {
          shortest = index;
          shortestHeight = current;
        }
      }
      const columnX = LAYOUT_PADDING + shortest * (cellWidth + LAYOUT_GAP);
      placement.push({ id: pane.id, x: Math.round(columnX + (cellWidth - width) / 2), y: Math.round(shortestHeight), width, height, zoom });
      columnHeights[shortest] = shortestHeight + height + LAYOUT_GAP;
    }
    const totalHeight = columnHeights.reduce((tallest, current) => Math.max(tallest, current), 0) - LAYOUT_GAP;
    const fit = Math.min(1, innerHeight / totalHeight);
    const coverage = panes.reduce((sum, pane) => {
      const zoom = widthZoom(pane) * fit;
      return sum + pane.viewportWidth * zoom * pane.viewportHeight * zoom;
    }, 0) / (innerWidth * innerHeight);
    if (coverage <= bestCoverage) continue;
    bestCoverage = coverage;
    // Overshoot: scale the finished arrangement uniformly toward the padding origin.
    bestPlacement = placement.map((tile) => ({
      ...tile,
      x: Math.round(LAYOUT_PADDING + (tile.x - LAYOUT_PADDING) * fit),
      y: Math.round(LAYOUT_PADDING + (tile.y - LAYOUT_PADDING) * fit),
      width: Math.round(tile.width * fit),
      height: Math.round(tile.height * fit),
      zoom: tile.zoom * fit,
    }));
  }
  for (const tile of bestPlacement) {
    const stored = positions[tile.id];
    if (!stored) { tiles.set(tile.id, tile); continue; }
    // Restored free positions must be clamped onto the CURRENT workspace extent, otherwise a
    // stale saved position after a window resize pushes panes outside and the native view
    // collapses to 1×1.
    const x = Math.max(LAYOUT_PADDING, Math.min(stored.x, LAYOUT_PADDING + innerWidth - tile.width));
    const y = Math.max(LAYOUT_PADDING, Math.min(stored.y, LAYOUT_PADDING + innerHeight - tile.height));
    tiles.set(tile.id, { ...tile, x, y });
  }
  return tiles;
}

function rect(element: HTMLElement) {
  const value = element.getBoundingClientRect();
  const x = Math.max(0, Math.min(window.innerWidth, Math.round(value.x)));
  const y = Math.max(0, Math.min(window.innerHeight, Math.round(value.y)));
  const right = Math.max(x, Math.min(window.innerWidth, Math.round(value.right)));
  const bottom = Math.max(y, Math.min(window.innerHeight, Math.round(value.bottom)));
  return { x, y, width: right - x, height: bottom - y };
}

function App({ usingDevMock }: { usingDevMock: boolean }) {
  const [state, dispatch] = useReducer(chromeReducer, undefined, initialChromeState);
  const [address, setAddress] = useState(state.sharedUrl);
  const snapshotPending = useRef(false);
  const stateReceived = useRef(false);
  const latestSharedUrl = useRef(state.sharedUrl);
  const addressFocused = useRef(false);
  const addressDirty = useRef(false);
  const requestEmit = useRef<() => void>(() => {});
  const expectedSurfaceCount = useRef(0);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const [workspaceSize, setWorkspaceSize] = useState({ width: 0, height: 0 });
  const workspaceSizeRef = useRef(workspaceSize);
  workspaceSizeRef.current = workspaceSize;
  const measuredRef = useRef(workspaceSize.width > 0 && workspaceSize.height > 0);
  measuredRef.current = workspaceSize.width > 0 && workspaceSize.height > 0;
  const layoutRef = useRef(state.layout);
  layoutRef.current = state.layout;
  const observerRef = useRef<ResizeObserver | null>(null);
  const focusAnchorRef = useRef<{ id: string; element: HTMLElement } | null>(null);
  const orderRef = useRef(state.order);
  const keyboardMoveRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const kbOriginRef = useRef<{ x: number; y: number } | null>(null);
  const wasDraggingRef = useRef(false);
  useEffect(() => {
    const section = workspaceRef.current;
    if (!section) return;
    const measure = () => setWorkspaceSize({ width: section.clientWidth, height: section.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(section);
    return () => observer.disconnect();
  }, []);
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
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const [guides, setGuides] = useState<{ xs: number[]; ys: number[] }>({ xs: [], ys: [] });
  const [keyboardMove, setKeyboardMove] = useState<{ id: string; x: number; y: number } | null>(null);
  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;
  keyboardMoveRef.current = keyboardMove;
  // Shared teardown so an unmount mid-drag cannot strand window listeners or guides.
  const endDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => endDragRef.current?.(), []);
  const startPaneDrag = useCallback((paneId: string, event: PointerEvent): void => {
    // Dragging rearranges stored free positions; in generated layouts a header gesture must
    // neither move panes nor persist a move-pane command. A live drag is detected via
    // endDragRef, which flips synchronously at listener install — drag state is async-batched.
    if (endDragRef.current || layoutRef.current !== "free") return;
    setKeyboardMove(null);
    const tile = tilesRef.current.get(paneId);
    if (!tile || tile.hidden || event.button !== 0) return;
    const offsetX = event.clientX - tile.x;
    const offsetY = event.clientY - tile.y;
    // Only a real pointer movement turns the gesture into a move-pane; a bare header click
    // must not persist anything or it would freeze the masonry seed in place.
    let moved = false;

    const move = (moveEvent: PointerEvent): void => {
      moved = true;
      const currentTiles = tilesRef.current;
      // The workspace extent is re-read every frame so resizes mid-drag are honored;
      // clientWidth/clientHeight is the single metric source (no border-box mix).
      const width = workspaceRef.current?.clientWidth ?? workspaceSizeRef.current.width;
      const height = workspaceRef.current?.clientHeight ?? workspaceSizeRef.current.height;
      const dragged = currentTiles.get(paneId);
      const cardWidth = dragged?.width ?? 0;
      const cardHeight = dragged?.height ?? 0;
      const clampToWorkspace = (value: number, extent: number, size: number): number =>
        Math.max(0, Math.min(extent - size, Math.round(value)));
      let x = clampToWorkspace(moveEvent.clientX - offsetX, width, cardWidth);
      let y = clampToWorkspace(moveEvent.clientY - offsetY, height, cardHeight);
      // Automatic alignment: snap the dragged card's edges to sibling edges within SNAP_PX.
      // Exactly ONE candidate per axis wins — the nearest edge match judged against the PRE-snap
      // value — so matches can no longer compound last-match-wins style.
      const snapXs: number[] = [LAYOUT_PADDING, width - LAYOUT_PADDING - cardWidth];
      const snapYs: number[] = [LAYOUT_PADDING, height - LAYOUT_PADDING - cardHeight];
      for (const sibling of currentTiles.values()) {
        if (sibling.id === paneId || sibling.hidden) continue;
        snapXs.push(sibling.x, sibling.x + sibling.width);
        snapYs.push(sibling.y, sibling.y + sibling.height);
      }
      const nearestSnap = (pre: number, extent: number, candidates: readonly number[]): { value: number; guide: number } | null => {
        let best: { value: number; guide: number; distance: number } | null = null;
        for (const candidate of candidates) {
          const startDistance = Math.abs(pre - candidate);
          if (startDistance <= SNAP_PX && (best === null || startDistance < best.distance)) best = { value: candidate, guide: candidate, distance: startDistance };
          const endDistance = Math.abs(pre + extent - candidate);
          if (endDistance <= SNAP_PX && (best === null || endDistance < best.distance)) best = { value: candidate - extent, guide: candidate, distance: endDistance };
        }
        return best;
      };
      const snappedX = nearestSnap(x, cardWidth, snapXs);
      const snappedY = nearestSnap(y, cardHeight, snapYs);
      if (snappedX) x = snappedX.value;
      if (snappedY) y = snappedY.value;
      // Post-snap re-clamp so emitted move-pane payloads always satisfy int >= 0 bounds.
      x = clampToWorkspace(x, width, cardWidth);
      y = clampToWorkspace(y, height, cardHeight);
      const activeXs = snappedX ? [snappedX.guide] : [];
      const activeYs = snappedY ? [snappedY.guide] : [];
      setGuides((prev) =>
        prev.xs.length === activeXs.length && prev.ys.length === activeYs.length &&
        prev.xs.every((value, index) => value === activeXs[index]) &&
        prev.ys.every((value, index) => value === activeYs[index])
          ? prev
          : { xs: activeXs, ys: activeYs },
      );
      setDrag((prev) => (prev !== null && prev.id === paneId && prev.x === x && prev.y === y ? prev : { id: paneId, x, y }));
      // The native WebContentsView follows the card only when main receives fresh bounds.
      // requestEmit coalesces via snapshotPending: at most one IPC per animation frame.
      requestEmit.current();
    };
    // Shared end path for pointerup AND pointercancel so an interrupted gesture can never
    // strand listeners or guides; unmount reuses it via endDragRef.
    const end = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      endDragRef.current = null;
      // A layout switch mid-gesture must not commit a stale free-position payload.
      const layoutStillFree = layoutRef.current === "free";
      setDrag((current) => {
        if (moved && layoutStillFree && current && current.id === paneId) {
          window.hoolypaneChrome.send({ kind: "move-pane", paneId, x: current.x, y: current.y });
        }
        return null;
      });
      setGuides({ xs: [], ys: [] });
      // Final emission is deferred: the drag===null effect below waits out the revert render
      // (double-rAF) so bounds are measured from settled DOM, not from the last dragged frame.
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    endDragRef.current = end;
    wasDraggingRef.current = true;
    setDrag({ id: paneId, x: tile.x, y: tile.y });
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

  const startKeyboardMove = useCallback((paneId: string): void => {
    // Mirrors startPaneDrag: keyboard moves rearrange stored free positions, so they must
    // not arm in generated layouts where a move-pane command would freeze masonry seeds.
    if (endDragRef.current || layoutRef.current !== "free") return;
    const tile = tilesRef.current.get(paneId);
    if (!tile || tile.hidden) return;
    kbOriginRef.current = { x: tile.x, y: tile.y };
    setKeyboardMove({ id: paneId, x: tile.x, y: tile.y });
  }, []);

  // Keyboard-move mode: arrows nudge the card by snap increments (each step sends move-pane),
  // Enter commits, Escape restores the origin. Pointer drag behavior is untouched.
  const kbActive = keyboardMove !== null;
  useEffect(() => {
    if (!kbActive) return;
    const onKey = (event: KeyboardEvent): void => {
      const current = keyboardMoveRef.current;
      if (!current) return;
      const tile = tilesRef.current.get(current.id);
      if (!tile || tile.hidden) {
        setKeyboardMove(null);
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
        const width = workspaceRef.current?.clientWidth ?? 0;
        const height = workspaceRef.current?.clientHeight ?? 0;
        const dx = event.key === "ArrowRight" ? SNAP_PX : event.key === "ArrowLeft" ? -SNAP_PX : 0;
        const dy = event.key === "ArrowDown" ? SNAP_PX : event.key === "ArrowUp" ? -SNAP_PX : 0;
        // Clamp nudges to the same padded domain the free-tile restore clamp renders: a committed
        // gutter coordinate would re-render the card at its LAYOUT_PADDING clamp while the native
        // view keeps the committed position — a persistent visual and click-target desync.
        const x = Math.max(LAYOUT_PADDING, Math.min(width - LAYOUT_PADDING - tile.width, Math.round(current.x + dx)));
        const y = Math.max(LAYOUT_PADDING, Math.min(height - LAYOUT_PADDING - tile.height, Math.round(current.y + dy)));
        if (x !== current.x || y !== current.y) {
          setKeyboardMove({ id: current.id, x, y });
          window.hoolypaneChrome.send({ kind: "move-pane", paneId: current.id, x, y });
        }
      } else if (event.key === "Enter") {
        setKeyboardMove(null);
      } else if (event.key === "Escape") {
        setKeyboardMove(null);
        const origin = kbOriginRef.current;
        if (origin) window.hoolypaneChrome.send({ kind: "move-pane", paneId: current.id, x: origin.x, y: origin.y });
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
    if (state.layout !== "free") setKeyboardMove(null);
  }, [state.layout]);

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

  const orderKey = state.order.join("\u0000");
  const positionsKey = state.layout === "free" ? JSON.stringify(state.positions) : "";
  // Long-lived emission plumbing, installed once: resize/scroll drive requestEmit directly so a
  // ticking workspaceSize never rebuilds observers.
  useEffect(() => {
    let frame = 0;
    const emit = () => {
      snapshotPending.current = false;
      // Pre-measurement frames would carry all-zero bounds; the observer re-fires once the
      // workspace has a real extent.
      if (!measuredRef.current) return;
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
  }, [orderKey, state.layout]);
  // Pure position echoes (move-pane round-trips) resize nothing: request explicitly so the
  // corrective emission measures the settled layout.
  useEffect(() => {
    requestEmit.current();
  }, [positionsKey]);
  const send = useCallback<SendCommand>((command) => window.hoolypaneChrome.send(command), []);
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
    if (previous === state.order) return;
    orderRef.current = state.order;
    const anchor = focusAnchorRef.current;
    if (!anchor || anchor.element.isConnected) return;
    if (!previous.includes(anchor.id) || state.order.includes(anchor.id)) return;
    const startIndex = previous.indexOf(anchor.id);
    const candidates = [...previous.slice(startIndex + 1), ...previous.slice(0, startIndex)];
    for (const candidateId of candidates) {
      if (!state.order.includes(candidateId)) continue;
      const header = document.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(candidateId)}"][data-pane-header]`);
      if (header && !header.closest(".pane-card")?.classList.contains("hidden")) {
        header.focus();
        return;
      }
    }
    document.getElementById("address")?.focus();
  }, [state.order]);
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
        className="relative min-h-0 flex-1 overflow-auto p-2"
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
        {guides.xs.map((x) => (
          <div key={`gx${x}`} aria-hidden="true" class="pointer-events-none absolute inset-y-0 z-20 w-px bg-accent/70" style={{ left: x }} />
        ))}
        {guides.ys.map((y) => (
          <div key={`gy${y}`} aria-hidden="true" class="pointer-events-none absolute inset-x-0 z-20 h-px bg-accent/70" style={{ top: y }} />
        ))}
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
