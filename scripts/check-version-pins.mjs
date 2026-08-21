// Verifies that dependencies shared across workspace manifests use identical
// version specs, so a one-sided bump cannot silently fork type/API contracts.
import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";

const manifests = ["package.json"];
for await (const entry of glob("{apps,packages}/*/package.json")) manifests.push(entry);

const DEPENDENCY_TYPES = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const declarations = new Map();
for (const manifest of manifests) {
  const pkg = JSON.parse(await readFile(manifest, "utf8"));
  for (const section of DEPENDENCY_TYPES) {
    for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
      if (spec === "workspace:*") continue;
      const key = `${name}@${spec}`;
      if (!declarations.has(key)) declarations.set(key, []);
      declarations.get(key).push(`${manifest} (${section})`);
    }
  }
}

// Group by package name: every distinct spec of the same name is a potential drift.
const conflicts = [];
const byName = new Map();
for (const [key, locations] of declarations) {
  const separator = key.lastIndexOf("@");
  const name = key.slice(0, separator);
  const spec = key.slice(separator + 1);
  if (!byName.has(name)) byName.set(name, new Map());
  byName.get(name).set(spec, locations);
}
for (const [name, specs] of byName) {
  if (specs.size <= 1) continue;
  conflicts.push(`conflicting pins for ${name}:`);
  for (const [spec, locations] of specs) {
    conflicts.push(`  ${spec}\n    ${locations.join("\n    ")}`);
  }
}

if (conflicts.length > 0) {
  console.error(conflicts.join("\n"));
  process.exit(1);
}
console.log(`version pins consistent across ${manifests.length} manifests`);
