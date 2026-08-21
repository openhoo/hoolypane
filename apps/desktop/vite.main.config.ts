import { defineConfig } from "vite";
import { builtinModules } from "node:module";

export default defineConfig({
  build: {
    target: "node24",
    ssr: true,
    outDir: "dist/main",
    emptyOutDir: true,
    lib: {
      entry: {
        index: "src/main/index.ts",
        "overview-worker": "src/main/screenshots/overview-worker.ts",
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: ["electron", "sharp", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    },
  },
});
