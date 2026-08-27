import { readFile, writeFile } from "node:fs/promises";

const root = JSON.parse(await readFile("package.json", "utf8"));
const releaseManifests = ["apps/desktop/package.json", "packages/runner/package.json"];

for (const manifest of releaseManifests) {
  const pkg = JSON.parse(await readFile(manifest, "utf8"));
  pkg.version = root.version;
  await writeFile(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
}

process.stdout.write(`synchronized release manifests to ${root.version}\n`);
