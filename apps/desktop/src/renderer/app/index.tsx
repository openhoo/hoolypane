import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import { render } from "preact";
import { ChromeStateSchema, type ChromeCommand } from "@hoolypane/contracts";
import { ErrorToast, PaneCard, Toolbar, type SendCommand } from "./components.js";
import { installDevMock } from "./devMock.js";
import { chromeReducer, initialChromeState, type ChromeState } from "./state.js";
import "../styles.css";

function paneAreaClass(layout: ChromeState["layout"]): string {
  switch (layout) {
    case "grid":
      return "grid flex-1 auto-rows-fr content-start gap-2 overflow-auto p-2 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]";
    case "horizontal":
      return "flex flex-1 items-stretch gap-2 overflow-x-auto overflow-y-hidden p-2 [&>.pane-card]:h-auto [&>.pane-card]:w-[360px] [&>.pane-card]:shrink-0";
    case "focus":
      return "flex flex-1 gap-2 overflow-hidden p-2 [&>.pane-card]:min-w-0 [&>.pane-card]:flex-1";
  }
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
  const surfacesKey = `${state.order.join("\u0000")}|${state.layout}`;
  useEffect(() => {
    let frame = 0;
    const emit = () => {
      snapshotPending.current = false;
      const panes = [...document.querySelectorAll<HTMLElement>("[data-pane-surface]")].map((element) => ({ paneId: element.dataset.paneSurface ?? "", bounds: rect(element) }));
      window.hoolypaneChrome.sendBounds({ windowWidth: Math.max(1, window.innerWidth), windowHeight: Math.max(1, window.innerHeight), panes });
    };
    const request = () => { if (!stateReceived.current || snapshotPending.current) return; snapshotPending.current = true; frame = requestAnimationFrame(emit); };
    requestEmit.current = request;
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
  const orderedPanes = state.order
    .map((paneId) => state.panes.find((candidate) => candidate.id === paneId))
    .filter((pane) => pane !== undefined);
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
      <section aria-label="Browser panes" className={`min-h-0 ${paneAreaClass(state.layout)}`}>
        {orderedPanes.map((pane) => (
          <PaneCard
            key={pane.id}
            pane={pane}
            focused={state.focusedPaneId === pane.id}
            closable={state.order.length > 1}
            hidden={state.layout === "focus" && state.focusedPaneId !== null && state.focusedPaneId !== pane.id}
            send={send}
          />
        ))}
      </section>
      <footer class="flex h-5 shrink-0 items-center justify-center bg-panel text-[10px] text-mute">
        Hoolypane is AGPL-3.0-only software, provided without warranty. License and corresponding source accompany this application.
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
