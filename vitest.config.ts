import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@hoolypane/contracts/fsync": fileURLToPath(new URL("./packages/contracts/src/fsync.ts", import.meta.url)),
      "@hoolypane/contracts": fileURLToPath(new URL("./packages/contracts/src/index.ts", import.meta.url)),
      "@hoolypane/flow": fileURLToPath(new URL("./packages/flow/src/index.ts", import.meta.url)),
      "@hoolypane/recorder": fileURLToPath(new URL("./packages/recorder/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/desktop/src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
