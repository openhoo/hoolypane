import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 4173);
let results = [];
let appliedCount = 0;

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hoolypane fixture</title>
<style>body{font:16px system-ui;margin:0;padding:20px;background:#f4f6f8}main{max-width:900px;margin:auto;display:grid;gap:16px}label{display:grid;gap:4px}.row{display:flex;gap:12px;flex-wrap:wrap}@media(max-width:600px){body{background:#e8f2ff}.row{display:grid}}#scroller{height:100px;overflow:auto;border:1px solid #456;background:white}.space{height:800px;background:linear-gradient(#fff,#48a)}</style></head>
<body><main><h1>Responsive fixture</h1><div class="row"><label>Name<input data-testid="name" value=""></label><label>Theme<select data-testid="theme"><option value="light">Light</option><option value="dark">Dark</option></select></label><label><input data-testid="subscribe" type="checkbox"> Subscribe</label></div><label>Command<input data-testid="command"></label><button data-testid="apply">Apply</button><div id="scroller" data-testid="scroller"><div class="space"></div></div><output data-testid="status">idle</output></main>
<script>const status=document.querySelector('[data-testid=status]');document.querySelector('[data-testid=apply]').addEventListener('click',()=>{status.textContent='applied';navigator.sendBeacon('/applied')});document.querySelector('[data-testid=command]').addEventListener('keydown',event=>{if(event.key==='Enter')status.textContent='entered'});</script></body></html>`;

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
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => process.exit(0)));
