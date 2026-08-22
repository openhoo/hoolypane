import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import { render } from "preact";
import { ChromeStateSchema, type ChromeCommand, type PanePosition } from "@hoolypane/contracts";
import { ErrorToast, PaneCard, Toolbar, type SendCommand } from "./components.js";
import { installDevMock } from "./devMock.js";
import { chromeReducer, initialChromeState, type ChromeState } from "./state.js";
import "../styles.css";

const LAYOUT_PADDING = 8;
const LAYOUT_GAP = 8;
const PANE_HEADER_HEIGHT = 28;

interface PaneTile {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Content scale the emulation will apply; shown as a zoom chip when below 100%. */
  readonly zoom: number;
}

interface TileInput {
  readonly id: string;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

function tileFor(input: TileInput, cellWidth: number, cellHeight: number, x: number, y: number): PaneTile {
  const zoom = Math.max(0, Math.min(1, cellWidth / input.viewportWidth, cellHeight / input.viewportHeight));
  const width = Math.round(input.viewportWidth * zoom);
  const height = Math.round(PANE_HEADER_HEIGHT + input.viewportHeight * zoom);
  return { id: input.id, x: Math.round(x + (cellWidth - width) / 2), y: Math.round(y + (cellHeight - height) / 2), width, height, zoom };
}

/**
 * Tiles panes proportionally to their viewport aspect ratios (Polypane-style): cards are sized to the
 * scaled viewport instead of uniform grid cells, so a 1440×900 desktop site never shares cell
 * dimensions with a 390×844 phone. The grid column count maximizes covered area, which also degrades
 * gracefully in small tiled windows. Only visible panes receive tiles; focus-mode siblings are
 * rendered hidden so their zero rects keep the bounds contract intact.
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
    if (visible) tiles.set(visible.id, tileFor(visible, innerWidth, innerHeight - PANE_HEADER_HEIGHT, LAYOUT_PADDING, LAYOUT_PADDING));
    return tiles;
  }
  if (layout === "horizontal") {
    const contentHeight = innerHeight - PANE_HEADER_HEIGHT;
    let x = LAYOUT_PADDING;
    for (const pane of panes) {
      const zoom = Math.max(0, Math.min(1, contentHeight / pane.viewportHeight));
      const width = Math.round(pane.viewportWidth * zoom);
      tiles.set(pane.id, tileFor(pane, width, contentHeight, x, LAYOUT_PADDING));
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
    tiles.set(tile.id, stored ? { ...tile, x: stored.x, y: stored.y } : tile);
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
  const emitNowRef = useRef<() => void>(() => {});
  const expectedSurfaceCount = useRef(0);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const [workspaceSize, setWorkspaceSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const section = workspaceRef.current;
    if (!section) return;
    const measure = () => setWorkspaceSize({ width: section.clientWidth, height: section.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(section);
    return () => observer.disconnect();
  }, []);
  useEffect(() => window.hoolypaneChrome.subscribe((value) => {
    const parsed = ChromeStateSchema.safeParse(value);
    if (!parsed.success) { console.error("[hoolypane] rejected chrome state", parsed.error.message); return; }
    const next = parsed.data;
    const firstSnapshot = !stateReceived.current;
    stateReceived.current = true;
    latestSharedUrl.current = next.sharedUrl;
    dispatch({ type: "state", state: next });
    if (!addressFocused.current && !addressDirty.current) setAddress(next.sharedUrl);
    if (firstSnapshot) requestEmit.current();
  }), []);
  const orderedPanes = state.order
    .map((paneId) => state.panes.find((candidate) => candidate.id === paneId))
    .filter((pane) => pane !== undefined);
  const tiles = computePaneTiles(
    state.layout,
    workspaceSize.width,
    workspaceSize.height,
    orderedPanes.map((pane) => ({ id: pane.id, viewportWidth: pane.viewport.width, viewportHeight: pane.viewport.height })),
    state.focusedPaneId,
    state.layout === "free" ? state.positions : {},
  );
  expectedSurfaceCount.current = orderedPanes.length;
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const [guides, setGuides] = useState<{ xs: number[]; ys: number[] }>({ xs: [], ys: [] });
  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;
  const startPaneDrag = (paneId: string, event: PointerEvent): void => {
    const tile = tilesRef.current.get(paneId);
    if (!tile || event.button !== 0) return;
    const offsetX = event.clientX - tile.x;
    const offsetY = event.clientY - tile.y;
    const SNAP = 8;
    const bounds = workspaceRef.current?.getBoundingClientRect();
    const width = bounds?.width ?? workspaceSize.width;
    const height = bounds?.height ?? workspaceSize.height;

    const move = (moveEvent: PointerEvent): void => {
      const currentTiles = tilesRef.current;
      let x = Math.round(moveEvent.clientX - offsetX);
      let y = Math.round(moveEvent.clientY - offsetY);
      const dragged = currentTiles.get(paneId);
      const cardWidth = dragged?.width ?? 0;
      const cardHeight = dragged?.height ?? 0;
      x = Math.max(0, Math.min(width - cardWidth, x));
      y = Math.max(0, Math.min(height - cardHeight, y));
      // Automatic alignment: snap the dragged card's edges to sibling edges within an 8px radius
      // and surface the active alignment lines while dragging.
      const snapXs: number[] = [LAYOUT_PADDING, width - LAYOUT_PADDING - cardWidth];
      const snapYs: number[] = [LAYOUT_PADDING, height - LAYOUT_PADDING - cardHeight];
      for (const sibling of currentTiles.values()) {
        if (sibling.id === paneId) continue;
        snapXs.push(sibling.x, sibling.x + sibling.width);
        snapYs.push(sibling.y, sibling.y + sibling.height);
      }
      const activeXs: number[] = [];
      const activeYs: number[] = [];
      for (const candidate of snapXs) {
        if (Math.abs(x - candidate) <= SNAP) { x = candidate; activeXs.push(candidate); }
        else if (Math.abs(x + cardWidth - candidate) <= SNAP) { x = candidate - cardWidth; activeXs.push(candidate); }
      }
      for (const candidate of snapYs) {
        if (Math.abs(y - candidate) <= SNAP) { y = candidate; activeYs.push(candidate); }
        else if (Math.abs(y + cardHeight - candidate) <= SNAP) { y = candidate - cardHeight; activeYs.push(candidate); }
      }
      setGuides({ xs: [...new Set(activeXs)], ys: [...new Set(activeYs)] });
      setDrag({ id: paneId, x, y });
      // The native WebContentsView follows the card only when main receives fresh bounds —
      // coalesce one emit per frame while dragging.
      window.requestAnimationFrame(() => emitNowRef.current());
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag((current) => {
        if (current && current.id === paneId) window.hoolypaneChrome.send({ kind: "move-pane", paneId, x: current.x, y: current.y });
        return null;
      });
      setGuides({ xs: [], ys: [] });
      window.requestAnimationFrame(() => emitNowRef.current());
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    setDrag({ id: paneId, x: tile.x, y: tile.y });
  };

  const surfacesKey = `${state.order.join("\u0000")}|${state.layout}|${workspaceSize.width}×${workspaceSize.height}`;
  useEffect(() => {
    let frame = 0;
    const emit = () => {
      snapshotPending.current = false;
      const surfaces = [...document.querySelectorAll<HTMLElement>("[data-pane-surface]")];
      // A snapshot missing panes would fail the main-side validation; wait until every pane card
      // exists (post-measurement) before emitting.
      if (surfaces.length !== expectedSurfaceCount.current || surfaces.length === 0) return;
      window.hoolypaneChrome.sendBounds({
        windowWidth: Math.max(1, window.innerWidth),
        windowHeight: Math.max(1, window.innerHeight),
        panes: surfaces.map((element) => ({ paneId: element.dataset.paneSurface ?? "", bounds: rect(element) })),
      });
    };
    const request = () => { if (!stateReceived.current || snapshotPending.current) return; snapshotPending.current = true; frame = requestAnimationFrame(emit); };
    requestEmit.current = request;
    emitNowRef.current = emit;
    const observer = new ResizeObserver(request);
    document.querySelectorAll<HTMLElement>("[data-pane-surface]").forEach((element) => observer.observe(element));
    window.addEventListener("resize", request);
    window.addEventListener("scroll", request, true);
    request();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      snapshotPending.current = false;
      observer.disconnect();
      window.removeEventListener("resize", request);
      window.removeEventListener("scroll", request, true);
    };
  }, [surfacesKey]);

  const send: SendCommand = (command: ChromeCommand) => window.hoolypaneChrome.send(command);
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
  return (
    <main class="flex h-screen w-screen flex-col overflow-hidden bg-canvas font-sans text-[13px] text-ink">
      <Toolbar
        state={state}
        address={address}
        onAddressInput={setAddress}
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
          const tile = drag && drag.id === pane.id ? { ...(baseTile ?? { id: pane.id, zoom: 1, width: 0, height: 0 }), x: drag.x, y: drag.y } : baseTile;
          const focusHidden = state.layout === "focus" && state.focusedPaneId !== null && state.focusedPaneId !== pane.id;
          if (!tile && !focusHidden) return null;
          return (
            <PaneCard
              key={pane.id}
              pane={pane}
              focused={state.focusedPaneId === pane.id}
              closable={state.order.length > 1}
              dragging={drag?.id === pane.id}
              onHeaderPointerDown={(event) => startPaneDrag(pane.id, event)}
              {...(tile ? { placement: { x: tile.x, y: tile.y, width: tile.width, height: tile.height }, zoom: tile.zoom } : {})}
              hidden={!tile || focusHidden}
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
