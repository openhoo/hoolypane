import { builtinModules } from "node:module";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
  const name = mode === "pane" ? "pane" : "chrome";
  return {
    build: {
      target: "chrome120",
      outDir: "dist/preload",
      emptyOutDir: name === "chrome",
      rollupOptions: {
        input: `src/preload/${name}.ts`,
        external: ["electron", ...builtinModules, ...builtinModules.map((module) => `node:${module}`)],
        output: { format: "cjs", entryFileNames: `${name}.js`, inlineDynamicImports: true },
      },
    },
  };
});
