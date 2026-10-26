// Shared pins must stay exact and catalog-managed; Effect's release also owns the Windows patch.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const workspace = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert(workspace.workspaces?.catalog, "Missing default dependency catalog");
const catalog = new Map(Object.entries(workspace.workspaces.catalog));
for (const [name, version] of catalog) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/, `${name} must be exact`);
}
assert.equal(
  workspace.packageManager,
  `bun@${readFileSync(join(root, ".bun-version"), "utf8").trim()}`,
);
const nodeVersion = readFileSync(join(root, ".node-version"), "utf8").trim();
assert.match(nodeVersion, /^\d+\.\d+\.\d+$/, "Development/CI Node must have an exact pin");
const nodeMajor = nodeVersion.split(".")[0];
assert.equal(workspace.engines.node, `>=${nodeMajor}`, "Node engine must match the CI major");
assert.equal(
  catalog.get("@types/node").split(".")[0],
  nodeMajor,
  "Node types must match the development/CI major",
);
assert.deepEqual(workspace.trustedDependencies.toSorted(), ["electron", "node-pty"]);
const effectFamily = [
  "effect",
  "@effect/platform-node",
  "@effect/sql-sqlite-node",
  "@effect/vitest",
];
const shared = new Set([
  ...effectFamily,
  "ai",
  "@modelcontextprotocol/sdk",
  "node-pty",
  "ghostty-web",
]);
for (const name of shared) {
  assert.match(catalog.get(name) ?? "", /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/, `${name} must be exact`);
}
for (const name of effectFamily) {
  assert.equal(catalog.get(name), catalog.get("effect"), `${name} must match the Effect release`);
}

const manifests = [
  "package.json",
  ...["apps", "packages"].flatMap((directory) =>
    readdirSync(join(root, directory), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name, "package.json"))
      .filter((path) => existsSync(join(root, path))),
  ),
];
for (const path of manifests) {
  const manifest = JSON.parse(readFileSync(join(root, path), "utf8"));
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (!shared.has(name) && !name.startsWith("@effect/")) continue;
      assert(catalog.has(name), `${path}: ${name} needs an exact catalog pin`);
      assert.equal(version, "catalog:", `${path}: ${name} must use catalog:`);
      if (name.startsWith("@effect/")) {
        assert.equal(
          catalog.get(name),
          catalog.get("effect"),
          `${name} must match the Effect release`,
        );
      }
    }
  }
}

assert.equal(
  /^electronVersion:\s*(\S+)/m.exec(
    readFileSync(join(root, "apps/desktop/electron-builder.yml"), "utf8"),
  )?.[1],
  catalog.get("electron"),
  "Electron packaging must match the catalog pin",
);

const patches = Object.entries(workspace.patchedDependencies ?? {});
assert(patches.length === 1, "The existing Windows Effect patch must be retained");
for (const [name, path] of patches) {
  const version = name.replace("@effect/platform-node-shared@", "");
  assert.equal(version, catalog.get("effect"), "Windows patch key must match the Effect release");
  assert(existsSync(join(root, path)), "Windows Effect patch file is missing");
}
