// Validate the deliberately narrow metadata contract before the API-only write job.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export function validateReleaseMetadata(read) {
  const config = JSON.parse(read("release-please-config.json"));
  const manifest = JSON.parse(read(".release-please-manifest.json"));
  const pkg = JSON.parse(read("package.json"));
  const desktop = JSON.parse(read("apps/desktop/package.json"));
  assert.deepEqual(Object.keys(config.packages), ["."], "Only Gram desktop is released");
  assert(!config.plugins?.length, "Workspace plugins must not rewrite dependency pins");
  const options = config.packages["."];
  assert.equal(options["release-type"], "node");
  assert.equal(options.versioning, "prerelease");
  assert.equal(options.prerelease, false, "Main proposes stable metadata");
  assert.equal(options["skip-github-release"], true, "Publication stays separate");
  assert.equal(options["draft-pull-request"], true);
  assert.equal(options["include-component-in-tag"], false);
  assert.equal(options["include-v-in-tag"], true);
  assert.deepEqual(options["extra-files"], [
    { type: "json", path: "apps/desktop/package.json", jsonpath: "$.version" },
    { type: "generic", path: "bun.lock" },
  ]);
  assert(!options["release-as"], "Do not leave a forced version in subsequent cycles");
  // The repository starts at one commit, and the v1.0.0 release on it is the baseline.
  assert(
    !config["bootstrap-sha"],
    "Do not pin history to a commit; the last release is the baseline",
  );
  assert(!config["last-release-sha"], "Do not freeze changelog history across release cycles");
  assert.deepEqual(Object.keys(manifest), ["."]);
  assert.equal(pkg.private, true);
  assert.equal(desktop.private, true);
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/, "Stable or explicit RC only");
  assert.equal(desktop.version, pkg.version, "Root and desktop versions must agree");
  assert.equal(manifest["."], pkg.version, "Manifest baseline must match metadata");
  const lock = read("bun.lock");
  assert.equal((lock.match(/x-release-please/g) ?? []).length, 1, "Exactly one lock annotation");
  // Bun's JSONC cannot use GenericJson. Fail closed if the one annotated field moves.
  const field = lock.match(
    /^    "apps\/desktop": \{\n      "name": "@gram\/desktop",\n      "version": "([^"]+)", \/\/ x-release-please-version$/m,
  );
  assert(field, "Annotate only the desktop workspace version");
  assert.equal(field[1], pkg.version, "Lock workspace version must match metadata");
  return pkg.version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = validateReleaseMetadata((path) => readFileSync(resolve(root, path), "utf8"));
  console.log(`Release metadata contract OK (${version}; PR-only)`);
}
