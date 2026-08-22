import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 4173);
let results = [];
let appliedCount = 0;

// Realistic SaaS landing page ("Nimbus Analytics") used as the demo site in every pane.
// The data-testid hooks (name, theme, subscribe, command, apply, scroller, status) and their
// behaviors are an E2E contract — restyle freely, never rename or rewire them.
const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nimbus Analytics — Understand every session</title>
<style>
:root{--bg:#f7f8fb;--surface:#ffffff;--ink:#101322;--muted:#5b6172;--line:#e4e7ef;--accent:#4f46e5;--accent-soft:#eef0ff;--ok:#059669}
*{box-sizing:border-box}
body{font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;background:var(--bg);color:var(--ink)}
a{color:inherit;text-decoration:none}
nav{position:sticky;top:0;display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px;padding:12px 28px;background:#ffffff;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:16px;letter-spacing:-.01em}
.mark{width:24px;height:24px;border-radius:7px;background:linear-gradient(135deg,#6366f1,#22d3ee)}
nav .links{display:flex;gap:18px;color:var(--muted);font-size:14px}
nav .spacer{flex:1}
.btn{white-space:nowrap;display:inline-flex;align-items:center;gap:7px;border-radius:9px;padding:8px 15px;font-size:13.5px;font-weight:600;border:1px solid transparent;cursor:pointer}
.btn-primary{background:var(--accent);color:#fff}
.btn-ghost{border-color:var(--line);background:var(--surface);color:var(--ink)}
header.hero{max-width:1060px;margin:0 auto;padding:64px 28px 40px;text-align:center}
.pill{display:inline-flex;align-items:center;gap:7px;background:var(--accent-soft);color:var(--accent);font-size:12.5px;font-weight:600;border-radius:999px;padding:5px 13px}
h1{font-size:clamp(30px,5vw,52px);line-height:1.06;letter-spacing:-.03em;margin:18px 0 14px}
h1 em{font-style:normal;background:linear-gradient(100deg,#6366f1,#06b6d4);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{color:var(--muted);font-size:17px;max-width:560px;margin:0 auto 26px}
.cta-row{display:flex;gap:11px;justify-content:center;flex-wrap:wrap}
.shot{max-width:900px;margin:38px auto 0;border-radius:14px;border:1px solid var(--line);background:var(--surface);box-shadow:0 24px 60px -30px rgba(23,25,60,.35);overflow:hidden;text-align:left}
.shot .bar{display:flex;align-items:center;gap:6px;padding:10px 14px;border-bottom:1px solid var(--line);background:#fafbfe}
.dot{width:10px;height:10px;border-radius:50%}
.shot .url{flex:1;margin-left:8px;background:var(--bg);border:1px solid var(--line);border-radius:6px;font-size:11.5px;color:var(--muted);padding:4px 10px}
.dash{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:16px}
.kpi{border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.kpi b{display:block;font-size:21px;letter-spacing:-.02em}
.kpi span{font-size:11.5px;color:var(--muted)}
.trend{height:74px;border-radius:8px;margin-top:10px;background:linear-gradient(180deg,#eef0ff,#fff);position:relative;overflow:hidden}
.trend::after{content:"";position:absolute;inset:auto 0 0 0;height:46%;background:linear-gradient(180deg,rgba(99,102,241,.45),rgba(34,211,238,.08));clip-path:polygon(0 78%,12% 62%,25% 70%,38% 44%,50% 56%,63% 30%,76% 42%,88% 18%,100% 30%,100% 100%,0 100%)}
.kpi:nth-child(2) .trend::after{background:linear-gradient(180deg,rgba(16,185,129,.4),rgba(16,185,129,.05));clip-path:polygon(0 70%,15% 74%,30% 52%,45% 60%,60% 38%,75% 48%,90% 26%,100% 36%,100% 100%,0 100%)}
.kpi:nth-child(3) .trend::after{background:linear-gradient(180deg,rgba(251,191,36,.35),rgba(251,191,36,.04));clip-path:polygon(0 40%,14% 55%,28% 35%,42% 66%,57% 50%,71% 72%,85% 58%,100% 80%,100% 100%,0 100%)}
.logos{display:flex;gap:34px;justify-content:center;align-items:center;padding:26px 20px;color:#9aa1b2;font-weight:700;letter-spacing:.06em;font-size:13px;flex-wrap:wrap}
section.features{max-width:1060px;margin:0 auto;padding:34px 28px 10px}
h2{font-size:clamp(22px,3vw,30px);letter-spacing:-.02em;margin:0 0 6px}
.lede{color:var(--muted);margin:0 0 24px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:13px;padding:18px}
.card .ico{width:34px;height:34px;border-radius:9px;display:grid;place-items:center;background:var(--accent-soft);margin-bottom:11px}
.card h3{margin:0 0 5px;font-size:15.5px}
.card p{margin:0;color:var(--muted);font-size:13.5px}
.console{max-width:780px;margin:44px auto;padding:0 28px}
.panel{background:#14162b;color:#e8eaf6;border:1px solid #262a4d;border-radius:15px;padding:20px;box-shadow:0 24px 60px -32px rgba(23,25,60,.5)}
.panel h2,.panel .lede{color:#fff}
.panel .lede{color:#a7adcf}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:640px){.grid2{grid-template-columns:1fr}}
@media(max-width:760px){nav{padding:12px 18px}nav .links{display:none}}
@media(max-width:480px){nav .btn-ghost{display:none}.hero{padding:40px 16px 24px}section.features,.console{padding-left:16px;padding-right:16px}}
@media(max-width:220px){.brand span:last-of-type{font-size:13px}nav{gap:8px}}
@media(max-width:720px){.dash{grid-template-columns:1fr}.kpi b{font-size:18px}}
.field{display:grid;gap:5px;font-size:12px;color:#a7adcf}
.panel [data-testid]{scroll-margin-top:80px}
.field input,.field select{background:#1d2040;border:1px solid #33375f;color:#e8eaf6;border-radius:8px;padding:8px 10px;font:inherit;font-size:13.5px;outline:none}
.field input:focus,.field select:focus{border-color:#6c72ff}
.check{display:flex;align-items:center;gap:8px;font-size:13px;color:#cdd2ee}
.actions{display:flex;gap:10px;align-items:center;margin-top:14px;flex-wrap:wrap}
.status-chip{margin-left:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:#1d2040;border:1px solid #33375f;border-radius:999px;padding:5px 12px;color:#9be8c5}
.scroller{margin-top:14px;height:110px;overflow:auto;border:1px solid #33375f;border-radius:10px;background:#191c38}
.scroller .space{height:800px;background:linear-gradient(180deg,#232750,#14162b 70%,#1b3a5e)}
.hint{font-size:11.5px;color:#7d84ad;margin-top:8px}
footer{border-top:1px solid var(--line);margin-top:48px;padding:26px 28px;display:flex;gap:18px;justify-content:space-between;color:var(--muted);font-size:12.5px;flex-wrap:wrap}
</style></head>
<body>
<nav>
  <span class="brand"><span class="mark"></span>Nimbus</span>
  <span class="links"><a href="#">Product</a><a href="#">Docs</a><a href="#">Pricing</a><a href="#">Changelog</a></span>
  <span class="spacer"></span>
  <a class="btn btn-ghost" href="#">Sign in</a>
  <a class="btn btn-primary" href="#">Start free</a>
</nav>

<section class="console" id="demo">
  <div class="panel">
    <h2>Live demo console</h2>
    <p class="lede">This panel is wired to a real backend — change the values and watch the status react.</p>
    <div class="grid2">
      <label class="field">Display name<input data-testid="name" value="" placeholder="Ada Lovelace"></label>
      <label class="field">Interface theme<select data-testid="theme"><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <label class="check"><input data-testid="subscribe" type="checkbox"> Subscribe to the Nimbus changelog</label>
      <label class="field">Quick command<input data-testid="command" placeholder="Type and press Enter"></label>
    </div>
    <div class="actions">
      <button class="btn btn-primary" data-testid="apply">Apply changes</button>
      <output class="status-chip" data-testid="status">idle</output>
    </div>
    <div class="scroller" data-testid="scroller"><div class="space"></div></div>
    <p class="hint">Scroll the stream above — Nimbus ingests events continuously.</p>
  </div>
</section>

<header class="hero">
  <span class="pill">● New · Session Replay 2.0</span>
  <h1>Understand every session,<br><em>without drowning in dashboards</em></h1>
  <p class="sub">Nimbus turns raw product analytics into clear, human-readable stories — funnels, replays and anomalies in one place.</p>
  <div class="cta-row">
    <a class="btn btn-primary" href="#demo">Try the live demo</a>
    <a class="btn btn-ghost" href="#">Book a walkthrough</a>
  </div>
  <div class="shot">
    <div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="url">app.nimbus.dev/overview</span></div>
    <div class="dash">
      <div class="kpi"><b>48,201</b><span>Sessions this week</span><div class="trend"></div></div>
      <div class="kpi"><b>3.42%</b><span>Conversion rate</span><div class="trend"></div></div>
      <div class="kpi"><b>128 ms</b><span>p95 interaction delay</span><div class="trend"></div></div>
    </div>
  </div>
</header>

<div class="logos"><span>LUMEN</span><span>Northwind</span><span>Orbital</span><span>helio</span><span>Vantage</span></div>

<section class="features">
  <h2>Built for teams that ship weekly</h2>
  <p class="lede">Everything you need to see what your users actually experience.</p>
  <div class="cards">
    <div class="card"><div class="ico">◈</div><h3>Funnels that explain themselves</h3><p>Every drop-off is annotated with the sessions that caused it — no SQL required.</p></div>
    <div class="card"><div class="ico">◉</div><h3>Replay with context</h3><p>Jump from a metric straight into the exact moments that moved it.</p></div>
    <div class="card"><div class="ico">◆</div><h3>Anomaly watch</h3><p>Nimbus learns your baselines and pages you before customers do.</p></div>
  </div>
</section>

<footer>
  <span>© 2026 Nimbus Labs, Inc.</span>
  <span>Privacy · Terms · Status · hello@nimbus.dev</span>
</footer>

<script>
const status=document.querySelector('[data-testid=status]');
document.querySelector('[data-testid=apply]').addEventListener('click',()=>{status.textContent='applied';navigator.sendBeacon('/applied')});
document.querySelector('[data-testid=command]').addEventListener('keydown',event=>{if(event.key==='Enter')status.textContent='entered'});
</script>
</body></html>`;

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (request.method === "POST" && url.pathname === "/result") {
    let body = "";
    try {
      for await (const chunk of request) body += chunk;
      results.push(JSON.parse(body));
    } catch {
      response.writeHead(400).end();
      return;
    }
    response.writeHead(204).end();
    return;
  }
  if (request.method === "POST" && url.pathname === "/applied") {
    appliedCount += 1;
    response.writeHead(204).end();
    return;
  }
  if (url.pathname === "/applied-count") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ count: appliedCount }));
    return;
  }
  if (url.pathname === "/results") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(results));
    return;
  }
  if (url.pathname === "/reset") {
    results = [];
    appliedCount = 0;
    response.writeHead(204).end();
    return;
  }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(page);
});
server.on("error", (error) => {
  console.error(`fixture server error: ${error.message}`);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => console.log(`fixture ready http://127.0.0.1:${port}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  // Chromium panes hold keep-alive sockets open; force-close all connections so close() completes promptly.
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
});
