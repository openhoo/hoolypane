# @hoolypane/runner

The Hoolypane runner replays one Playwright flow against every configured viewport in parallel headless Chromium contexts, records synchronized traces, and encodes an aligned composite video of all panes.

Part of [Hoolypane](https://github.com/openhoo/hoolypane).

## Requirements

- Node.js 24 or newer
- Chromium installed for Playwright: `pnpm exec playwright install chromium`
- Bundled `ffmpeg-static`/`ffprobe-static`, or both `HOOLYPANE_FFMPEG_PATH` and `HOOLYPANE_FFPROBE_PATH`

## Usage

Define a config and a flow:

```ts
// hoolypane.config.ts
import { defineConfig } from "@hoolypane/runner";

export default defineConfig({
  baseURL: "http://127.0.0.1:4173",
  viewports: [
    { id: "desktop", name: "Desktop", width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
    { id: "phone", name: "Phone", width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  ],
});
```

```ts
// checkout.flow.ts
import { defineFlow } from "@hoolypane/runner";

export default defineFlow(async ({ all }) => {
  await all("open", async ({ page }) => page.goto("/"));
});
```

Run them with the CLI:

```sh
hoolypane run checkout.flow.ts [--config hoolypane.config.ts] [--output recordings] [--headed]
```

`--config` defaults to `hoolypane.config.ts` next to the current working directory. The runner writes the encoded composite video, the recording `manifest.json`, and Playwright traces to the output directory.

## License

AGPL-3.0-only. Bundled FFmpeg binaries are GPL-3.0-or-later; see `LICENSE-FFMPEG.txt` for source and license links.
