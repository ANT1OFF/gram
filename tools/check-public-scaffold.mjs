// Dependency-free checks for the boundaries of this private public-release scaffold.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { embeddedCredential, forbiddenReference, formerName } from "./scaffold-boundaries.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");
// Preview bundles contain third-party dependencies, just like ordinary dist output.
const excluded = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-e2e",
  "out",
  "release",
  "coverage",
]);
const files = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (excluded.has(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });

assert.match(read(".npmrc"), /^registry=https:\/\/registry\.npmjs\.org\/$/m);
assert(!/authToken|password/i.test(read(".npmrc")), "Registry config must not contain credentials");
assert.match(
  read("packages/shell/src/modules/update/config.ts"),
  /UPDATE_REPO: string \| null = "ANT1OFF\/gram";/,
);
assert.match(
  read("packages/contracts/src/settings.ts"),
  /automaticChecks: Schema\.optionalKey\(Schema\.Boolean\)/,
);
assert.match(read("apps/web/src/updates/use-update-check-on-launch.ts"), /!automaticChecks/);
assert.match(read("packages/server/src/main.ts"), /const McpCatalogueLayer = Layer\.empty;/);
// The packaged app ships generated third-party notices in Resources/ (tools/notices); afterPack
// and verify-package fail a package without them.
assert.match(
  read("apps/desktop/package.json"),
  /"build": "[^"]*&& node \.\.\/\.\.\/tools\/notices\/generate\.mjs"/,
);
assert.match(
  read("apps/desktop/electron-builder.yml"),
  /- from: \.\.\/\.\.\/out\/notices\/THIRD-PARTY-NOTICES\.txt\n\s+to: THIRD-PARTY-NOTICES\.txt/,
);
assert.match(read("apps/desktop/build/afterPack.cjs"), /THIRD-PARTY-NOTICES\.txt/);
assert.match(read("apps/desktop/scripts/verify-package.mjs"), /THIRD-PARTY-NOTICES\.txt present/);
// No GPL code ships: the install puts the speech-recognition-only sherpa-onnx build (tools/sherpa-onnx)
// over the npm one, which links espeak-ng, and verify-package fails a package with its symbols.
assert.match(read("package.json"), /"postinstall": "node tools\/sherpa-onnx\/install\.mjs"/);
assert.match(
  read("apps/desktop/scripts/verify-package.mjs"),
  /sherpa-onnx without espeak-ng or piper-phonemize/,
);
assert.doesNotMatch(read("tools/notices/native-components.json"), /GPL/);
const appId = /APP_ID = "([^"]+)"/.exec(read("apps/desktop/src/main/app-id.ts"))?.[1];
assert.equal(/^appId:\s*(\S+)$/m.exec(read("apps/desktop/electron-builder.yml"))?.[1], appId);
assert.equal(appId, "io.github.ant1off.gram");

// These inherited tests deliberately exercise redaction with synthetic token signatures.
const syntheticCredentialTests = new Set([
  "packages/server/src/orchestration/rules.test.ts",
  "packages/server/src/orchestration/service-restarts.test.ts",
  "packages/server/src/orchestration/tools.test.ts",
  "packages/server/src/issues/tools.test.ts",
  "packages/server/src/logging/service.test.ts",
  "packages/contracts/src/redact.test.ts",
]);
let checked = 0;
for (const area of ["apps", "packages", "tools", ".github"]) {
  for (const path of files(join(root, area))) {
    if (!/\.(?:[cm]?[jt]sx?|jsonl?|ya?ml|sh|plist|md|patch)$/.test(path)) continue;
    const content = readFileSync(path, "utf8");
    const relative = path.slice(root.length);
    assert(
      // Only the canonical pattern definitions contain the forbidden names themselves.
      relative === "tools/scaffold-boundaries.mjs" || !forbiddenReference.test(content),
      `Internal organization reference: ${relative}`,
    );
    assert(
      syntheticCredentialTests.has(relative) || !embeddedCredential.test(content),
      `Possible embedded credential: ${relative}`,
    );
    checked += 1;
  }
}

// No tracked path or text file names the project's former names.
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
for (const path of tracked) {
  assert(!formerName.test(path), `Former project name in a tracked path: ${path}`);
  // Symlinks are their own targets' business; binary files are checked by name only, since
  // their bytes can spell anything.
  if (!existsSync(join(root, path)) || !lstatSync(join(root, path)).isFile()) continue;
  const content = readFileSync(join(root, path));
  if (content.subarray(0, 8000).includes(0)) continue;
  const text = content.toString("utf8");
  const match = formerName.exec(text);
  assert(
    !match,
    `Former project name in ${path}:${match && text.slice(0, match.index).split("\n").length}`,
  );
}

console.log(`Scaffold boundaries pass (${checked} text files checked).`);
