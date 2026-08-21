module.exports = {
  forbidden: [
    { name: "no-cycles", severity: "error", from: {}, to: { circular: true } },
    {
      name: "contracts-platform-neutral",
      severity: "error",
      from: { path: "^packages/contracts/src" },
      to: { path: "(^|/)(electron|playwright|preact|node:|ffmpeg)" },
    },
    {
      name: "package-dag",
      severity: "error",
      from: { path: "^packages/flow/src" },
      to: { path: "^packages/(runner|recorder)/src" },
    },
    {
      name: "package-dag-reversed",
      severity: "error",
      from: { path: "^packages/contracts/src" },
      to: { path: "^packages/(flow|recorder|runner)/src" },
    },
    {
      name: "runner-dependencies",
      severity: "error",
      from: { path: "^packages/runner/src" },
      to: { path: "^apps/desktop/src" },
    },
    {
      name: "no-deep-contract-imports",
      severity: "error",
      from: { path: "^(apps|packages/(flow|recorder|runner))/" },
      to: { path: "^packages/contracts/src/", pathNot: "^packages/contracts/src/index\\.ts$" },
    },
    {
      name: "no-deep-flow-imports",
      severity: "error",
      from: { path: "^(apps|packages/runner)/" },
      to: { path: "^packages/flow/src/", pathNot: "^packages/flow/src/index\\.ts$" },
    },
    {
      name: "no-deep-recorder-imports",
      severity: "error",
      from: { path: "^packages/runner/" },
      to: { path: "^packages/recorder/src/", pathNot: "^packages/recorder/src/index\\.ts$" },
    },
  ],
  options: {
    doNotFollow: "node_modules",
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { extensions: [".ts", ".tsx", ".js"] },
  },
};
