import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  base: "./",
  root: "src/renderer",
  plugins: [preact()],
  build: {
    target: "chrome120",
    outDir: "../../dist/main/renderer",
    emptyOutDir: true,
  },
});
