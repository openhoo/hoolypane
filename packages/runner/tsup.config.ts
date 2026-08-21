import { defineConfig } from "tsup";

export default defineConfig({
  tsconfig: "tsconfig.bundle.json",
  entry: { index: "src/index.ts", cli: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node24",
  bundle: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  noExternal: ["@hoolypane/contracts", "@hoolypane/flow", "@hoolypane/recorder", "zod"],
  external: ["esbuild", "ffmpeg-static", "ffprobe-static", "playwright"],
});
