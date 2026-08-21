import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const target = process.argv[2];
const flagByTarget = { linux: "--linux", windows: "--windows", mac: "--mac" };
const targetFlag = flagByTarget[target];
if (!targetFlag) throw new Error("Usage: node scripts/package-desktop.mjs <linux|windows|mac>");
const hasCertificate = Boolean(process.env.CSC_LINK && process.env.CSC_KEY_PASSWORD);
const canNotarize = Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);
const signed = target === "windows" ? hasCertificate : target === "mac" ? hasCertificate && canNotarize : false;
const suffix = signed ? "signed" : "unsigned";
const artifactName = `\${productName}-\${version}-\${os}-\${arch}-${suffix}.\${ext}`;
const args = [targetFlag, "--publish", "never", "--config", "electron-builder.yml", `--config.artifactName=${artifactName}`];
if (target === "mac") {
  args.push(`--config.mac.notarize=${canNotarize}`);
  args.push(`--config.dmg.sign=${signed}`);
}
const environment = { ...process.env };
if (!hasCertificate) environment.CSC_IDENTITY_AUTO_DISCOVERY = "false";
const builderCli = createRequire(import.meta.url).resolve("electron-builder/cli.js");
const child = spawn(process.execPath, [builderCli, ...args], { stdio: "inherit", env: environment });
child.once("error", (error) => { throw error; });
child.once("exit", (code, signal) => {
  if (signal) throw new Error(`electron-builder terminated by ${signal}`);
  if (code !== 0) process.exitCode = code ?? 1;
});
