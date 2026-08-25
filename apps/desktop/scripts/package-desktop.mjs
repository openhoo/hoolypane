import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const target = process.argv[2];
const flagByTarget = { linux: "--linux", windows: "--windows", mac: "--mac" };
const targetFlag = Object.hasOwn(flagByTarget, target) ? flagByTarget[target] : undefined;
if (!targetFlag) throw new Error("Usage: node scripts/package-desktop.mjs <linux|windows|mac>");
const hasCertificate = Boolean(process.env.CSC_LINK && process.env.CSC_KEY_PASSWORD);
const canNotarize = Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);
const signed = target === "windows" ? hasCertificate : target === "mac" ? hasCertificate && canNotarize : false;
const suffix = signed ? "signed" : "unsigned";
const artifactName = `\${productName}-\${version}-\${os}-\${arch}-${suffix}.\${ext}`;
const args = [targetFlag, "--publish", "never", "--config", "electron-builder.yml"];
// Unsigned builds keep electron-builder.yml's byte-identical -unsigned template effective;
// only signed builds need the CLI override.
if (signed) args.push(`--config.artifactName=${artifactName}`);
if (target === "mac") {
  args.push(`--config.mac.notarize=${canNotarize}`);
  args.push(`--config.dmg.sign=${signed}`);
}
const environment = { ...process.env };
if (!signed) {
  // Gate on the effective signing decision: a mac build with a certificate but missing
  // notarization credentials must not sign either, or the "unsigned" artifact lies.
  delete environment.CSC_LINK;
  delete environment.CSC_KEY_PASSWORD;
  environment.CSC_IDENTITY_AUTO_DISCOVERY = "false";
}
if (!canNotarize) {
  delete environment.APPLE_ID;
  delete environment.APPLE_APP_SPECIFIC_PASSWORD;
  delete environment.APPLE_TEAM_ID;
}
const builderCli = createRequire(import.meta.url).resolve("electron-builder/cli.js");
const child = spawn(process.execPath, [builderCli, ...args], { stdio: "inherit", env: environment });
const forwardSignal = (signal) => child.kill(signal);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, forwardSignal);
child.once("error", (error) => { throw error; });
child.once("exit", (code, signal) => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.removeListener(signal, forwardSignal);
  if (signal) throw new Error(`electron-builder terminated by ${signal}`);
  if (code !== 0) process.exitCode = code ?? 1;
});
