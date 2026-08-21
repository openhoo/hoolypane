import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import { render } from "preact";
import { chromeReducer, customViewport, initialChromeState, type ChromeState } from "./state.js";
import "../styles/chrome.css";

function App(): preact.JSX.Element {
  const [state, dispatch] = useReducer(chromeReducer, undefined, initialChromeState);
  const [address, setAddress] = useState(state.sharedUrl);
  const snapshotPending = useRef(false);
  const stateReceived = useRef(false);
  const addressFocused = useRef(false);
  const addressDirty = useRef(false);
  useEffect(() => window.hoolypaneChrome.subscribe((value) => {
    if (!isWorkspace(value)) return;
    stateReceived.current = true;
    dispatch({ type: "state", state: value });
    if (!addressFocused.current && !addressDirty.current) setAddress(value.sharedUrl);
  }), []);
  useEffect(() => {
    const emit = () => {
      snapshotPending.current = false;
      const panes = [...document.querySelectorAll<HTMLElement>("[data-pane-surface]")].map((element) => ({ paneId: element.dataset.paneSurface ?? "", bounds: rect(element) }));
      window.hoolypaneChrome.sendBounds({ windowWidth: Math.max(1, window.innerWidth), windowHeight: Math.max(1, window.innerHeight), panes });
    };
    const request = () => { if (!stateReceived.current || snapshotPending.current) return; snapshotPending.current = true; requestAnimationFrame(emit); };
    const observer = new ResizeObserver(request);
    document.querySelectorAll<HTMLElement>("[data-pane-surface]").forEach((element) => observer.observe(element));
    window.addEventListener("resize", request);
    window.addEventListener("scroll", request, true);
    request();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", request);
      window.removeEventListener("scroll", request, true);
    };
  }, [state.order, state.layout]);

  const send = (command: Parameters<typeof window.hoolypaneChrome.send>[0]) => window.hoolypaneChrome.send(command);
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
      setAddress(state.sharedUrl);
    }, 0);
  };
  return <main className={`chrome chrome-${state.layout}`}>
    <header className="toolbar">
      <form onSubmit={navigate} className="address-form"><label for="address">Address</label><input id="address" value={address} onFocus={() => { addressFocused.current = true; }} onBlur={blurAddress} onInput={(event) => { addressDirty.current = true; setAddress((event.currentTarget as HTMLInputElement).value); }} /><button type="submit">Go</button></form>
      <button type="button" onClick={() => state.focusedPaneId && send({ kind: "back", paneId: state.focusedPaneId })}>Back</button>
      <button type="button" onClick={() => state.focusedPaneId && send({ kind: "forward", paneId: state.focusedPaneId })}>Forward</button>
      <button type="button" onClick={() => state.focusedPaneId && send({ kind: "reload", paneId: state.focusedPaneId })}>Reload</button>
      <button type="button" onClick={() => send({ kind: "create", viewport: customViewport(960, 720) })}>Add custom</button>
      <label for="layout">Layout</label><select id="layout" value={state.layout} onChange={(event) => send({ kind: "set-layout", layout: (event.currentTarget as HTMLSelectElement).value as "grid" | "horizontal" | "focus" })}><option value="grid">Grid</option><option value="horizontal">Horizontal</option><option value="focus">Focus</option></select>
      <label><input type="checkbox" checked={state.syncEnabled} onChange={(event) => send({ kind: "set-sync", enabled: (event.currentTarget as HTMLInputElement).checked })} /> Sync</label>
      <button type="button" aria-pressed={state.recording ?? false} onClick={() => send({ kind: state.recording ? "record-stop" : "record-start" })}>{state.recording ? "Stop Flow Recording" : "Start Flow Recording"}</button>
      <button type="button" onClick={() => send({ kind: "capture-overview" })}>Save Overview PNG</button>
    </header>
    <section className="pane-grid" aria-label="Browser panes">{state.order.map((paneId, index) => {
      const pane = state.panes.find((candidate) => candidate.id === paneId);
      if (!pane) return null;
      return <article className={`pane-card ${state.focusedPaneId === pane.id ? "focused" : ""}`} key={pane.id}>
        <header className="pane-header"><strong>{pane.name}</strong><span>{pane.viewport.width}×{pane.viewport.height}</span><button type="button" onClick={() => send({ kind: "focus", paneId: state.focusedPaneId === pane.id ? null : pane.id })}>{state.focusedPaneId === pane.id ? "Unfocus" : "Focus"}</button><button type="button" onClick={() => send({ kind: "rotate", paneId: pane.id })}>Rotate</button><button type="button" onClick={() => send({ kind: "capture-pane", paneId: pane.id })}>Save PNG</button><button type="button" onClick={() => send({ kind: "duplicate", paneId: pane.id })}>Duplicate</button><button type="button" onClick={() => send({ kind: "close", paneId: pane.id })} disabled={state.order.length === 1}>Close</button></header>
        <div className="pane-surface" data-pane-surface={pane.id} aria-label={`${pane.name} browser surface`}><button type="button" onClick={() => send({ kind: "focus", paneId: pane.id })}>Enter pane</button></div>
        <footer><label>Name <input value={pane.name} onChange={(event) => { const name = (event.currentTarget as HTMLInputElement).value; if (name.trim()) send({ kind: "rename", paneId: pane.id, name }); }} /></label><button type="button" onClick={() => send({ kind: "reorder", paneId: pane.id, index: Math.max(0, index - 1) })}>←</button><button type="button" onClick={() => send({ kind: "reorder", paneId: pane.id, index: index + 1 })}>→</button>{pane.failure && <span role="alert">{pane.failure}</span>}{pane.outOfSync && <span role="alert">Out of sync at {pane.outOfSync.actionKind} #{pane.outOfSync.actionId}: {pane.outOfSync.reason}</span>}</footer>
      </article>;
    })}</section>
    <p className="license-notice">Hoolypane is AGPL-3.0-only software, provided without warranty. License and corresponding source accompany this application.</p>
  </main>;
}

function rect(element: HTMLElement) {
  const value = element.getBoundingClientRect();
  const x = Math.max(0, Math.min(window.innerWidth, Math.round(value.x)));
  const y = Math.max(0, Math.min(window.innerHeight, Math.round(value.y)));
  const right = Math.max(x, Math.min(window.innerWidth, Math.round(value.right)));
  const bottom = Math.max(y, Math.min(window.innerHeight, Math.round(value.bottom)));
  return { x, y, width: right - x, height: bottom - y };
}
function isWorkspace(value: unknown): value is ChromeState { return Boolean(value && typeof value === "object" && "panes" in value && "order" in value && "layout" in value); }

render(<App />, document.getElementById("app")!);
