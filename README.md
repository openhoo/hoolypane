# Hoolypane

Hoolypane runs one web interaction across multiple responsive Chromium viewports. It provides a direct, GPU-composited Electron desktop and a Playwright headless runner. Live panes are native `WebContentsView` surfaces: page pixels are never streamed through IPC, canvas, or Preact.

## Requirements

- Node.js 24 or newer and pnpm 10
- Chromium installed for Playwright: `pnpm exec playwright install chromium`
- Linux, Windows, or macOS desktop graphics supported by Electron 43.4.1
- Bundled `ffmpeg-static`/`ffprobe-static`, or both `HOOLYPANE_FFMPEG_PATH` and `HOOLYPANE_FFPROBE_PATH`

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @hoolypane/desktop start
```

The desktop provides one address bar, preset/custom panes, grid/horizontal/focus layouts, synchronized click/form/key/ratio-scroll interactions, pane and overview PNG export, and Playwright flow recording. Remote panes share the persistent `persist:hoolypane` session. Permissions, downloads, external protocols, Node integration, and pop-up windows are denied.

## Configuration and flows

`hoolypane.config.ts`:

```ts
import { defineConfig } from "@hoolypane/runner";

export default defineConfig({
  baseURL: "http://127.0.0.1:4173",
  viewports: [
    { id: "desktop", name: "Desktop", width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
    { id: "phone", name: "Phone", width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  ],
});
```

`checkout.flow.ts`:

```ts
import { defineFlow } from "@hoolypane/runner";

export default defineFlow(async ({ all }) => {
  await all("open", async ({ page }) => page.goto("/"));
  await all("search", async ({ page }) => page.getByLabel("Search").fill("Hoolypane"));
  await all("submit", async ({ page }) => page.getByRole("button", { name: "Search" }).click());
});
```

```sh
hoolypane run checkout.flow.ts
hoolypane run checkout.flow.ts --config custom.config.ts --output results --headed
hoolypane verify results
```

Each viewport receives an isolated `BrowserContext` and `Page` in one Chromium process. `all()` starts every viewport callback before awaiting the barrier and reports all failures.

## Artifacts and synchronization

A completed run contains:

```text
manifest.json
run-state.json
traces/<viewport-id>.zip
videos/<viewport-id>.webm
videos/composite.webm
raw/                         # retained on failure or when keepRaw=true
```

`multi-viewport-cfr-v1` means every viewport video and the composite have exactly the same frame count, complete rational PTS/duration vector, zero start, and end time. Slot `k` selects the newest captured source frame at or before the shared target timestamp and holds the prior frame when no new paint exists. This guarantees zero output drift. Independent Chromium pages are not promised to paint on one physical compositor tick; acquisition skew is measured separately in `manifest.json`.

Recording is video-only. CDP screencasts provide no shared audio clock. The default is 60 fps, JPEG quality 85, a grid capped at 3840×2160, and a 250 ms post-roll.

## Architecture

Dependencies point one way:

```text
contracts <- flow
contracts <- recorder
contracts + flow + recorder <- runner
contracts + flow <- desktop
```

`contracts` contains only platform-neutral Zod schemas and inferred types. Electron remains under `apps/desktop`; Playwright lifecycle and CLI remain under `packages/runner`; frame spooling, encoding, and verification remain under `packages/recorder`. Dependency Cruiser, TypeScript project references, and Knip enforce cycles, deep imports, platform leaks, and dead code.

## Performance expectations

Six continuously animated direct panes target requestAnimationFrame p95 ≤20 ms, mirrored action application p95 <16.7 ms, no final-input loss, and no main/renderer long task above 50 ms. Recording uses bounded per-viewport queues of eight frames or 32 MiB and Chromium backpressure.

## License

Hoolypane is licensed under AGPL-3.0-only. Bundled FFmpeg binaries are GPL-3.0-or-later; see `packages/runner/LICENSE-FFMPEG.txt` for source and license links.
