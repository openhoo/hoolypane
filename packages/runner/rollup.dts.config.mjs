import { resolve } from "node:path";
import dts from "rollup-plugin-dts";

const internal = {
  "@hoolypane/contracts": resolve("../contracts/src/index.ts"),
  "@hoolypane/flow": resolve("../flow/src/index.ts"),
};

export default {
  input: "src/index.ts",
  output: { file: "dist/index.d.ts", format: "es" },
  external: ["playwright"],
  plugins: [
    { name: "hoolypane-internal-types", resolveId(source) { return internal[source] ?? null; } },
    dts({ respectExternal: false }),
  ],
};
