import { spawn } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
function run(command, args, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: environment });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code ?? signal}`)));
  });
}

await run(pnpm, ["architecture"]);
await run(pnpm, ["exec", "knip"]);
await run(pnpm, ["typecheck"]);
await run(pnpm, ["test:unit"]);
await run(pnpm, ["test:runner"]);
await run(pnpm, ["prepare:electron"]);
await run(pnpm, ["build"]);
if (process.platform === "linux") {
  const environment = { ...process.env, LIBGL_ALWAYS_SOFTWARE: "1" };
  delete environment.DBUS_SESSION_BUS_ADDRESS;
  delete environment.WAYLAND_DISPLAY;
  await run("dbus-run-session", ["--", "xvfb-run", "-a", pnpm, "test:desktop"], environment);
  await run("dbus-run-session", ["--", "xvfb-run", "-a", pnpm, "benchmark:desktop"], environment);
} else {
  await run(pnpm, ["test:desktop"]);
  await run(pnpm, ["benchmark:desktop"]);
}
await run(pnpm, ["benchmark:recording"]);
await run(pnpm, ["pack:runner"]);
const packageScript = process.platform === "win32" ? "package:windows" : process.platform === "darwin" ? "package:mac" : "package:linux";
await run(pnpm, [packageScript]);
if (process.platform === "linux") {
  const environment = { ...process.env, LIBGL_ALWAYS_SOFTWARE: "1" };
  delete environment.DBUS_SESSION_BUS_ADDRESS;
  delete environment.WAYLAND_DISPLAY;
  await run("dbus-run-session", ["--", "xvfb-run", "-a", pnpm, "smoke:desktop-package", "--", "dist/desktop"], environment);
} else {
  await run(pnpm, ["smoke:desktop-package", "--", "dist/desktop"]);
}
process.stdout.write("RELEASE_DRY_RUN_OK\n");
