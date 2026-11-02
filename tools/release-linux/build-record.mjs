#!/usr/bin/env node
// Run by .github/workflows/release-linux.yml after packaging and smoke: checks that what
// electron-builder made is this release (version, source commit, package metadata) and writes the
// release's Linux files into `--out`: the AppImage, the .deb and LINUX-BUILD.json, which records
// the version, source commit, run and each package's size and SHA-256. Nothing here holds a token.
//
//   node tools/release-linux/build-record.mjs --release <electron-builder output> --out <dir>
//        --version <v> --source <sha> --run-id <id> --run-attempt <n>
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  LINUX_BUILD_INFO,
  LINUX_REPO,
  LINUX_WORKFLOW,
  checkLinuxBuild,
  isAppImage,
  isDeb,
  linuxPackageNames,
  sha256File,
} from "./linux-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fail = (message) => {
  process.stderr.write(`build-record: ${message}\n`);
  process.exit(1);
};

const { values } = parseArgs({
  options: {
    release: { type: "string" },
    out: { type: "string" },
    version: { type: "string" },
    source: { type: "string" },
    "run-id": { type: "string" },
    "run-attempt": { type: "string" },
  },
});
const { release, out, version, source } = values;
if (!release || !out || !version || !/^[0-9a-f]{40}$/.test(source ?? "") || !values["run-id"])
  fail("needs --release, --out, --version, --source <sha>, --run-id and --run-attempt.");
const names = linuxPackageNames(version);
for (const name of Object.values(names))
  if (!existsSync(join(release, name))) fail(`${name} isn't in ${release}.`);
if (!isAppImage(join(release, names.appImage))) fail(`${names.appImage} isn't an AppImage.`);
if (!isDeb(join(release, names.deb))) fail(`${names.deb} isn't a Debian package.`);

// The unpacked app electron-builder made both packages from; verify-package.mjs has already
// checked that each package carries this same app.asar.
const asar = createRequire(join(ROOT, "package.json"))("@electron/asar");
const archive = join(release, "linux-unpacked/resources/app.asar");
const packaged = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
if (packaged.name !== "@gram/desktop" || packaged.version !== version)
  fail(`app.asar is ${packaged.name}@${packaged.version}, not @gram/desktop@${version}.`);
if (!asar.extractFile(archive, "out/main/index.js").toString().includes(source))
  fail("the packaged main doesn't embed the source commit (was the checkout clean?).");

const control = (field) =>
  execFileSync("dpkg-deb", ["--field", join(release, names.deb), field], {
    encoding: "utf8",
  }).trim();
for (const [field, want] of [
  ["Package", "gram"],
  ["Version", version],
  ["Architecture", "amd64"],
])
  if (control(field) !== want) fail(`the .deb's ${field} is ${control(field)}, not ${want}.`);

mkdirSync(out, { recursive: true });
if (readdirSync(out).length) fail(`${out} isn't empty.`);
const files = [];
for (const name of [names.appImage, names.deb]) {
  copyFileSync(join(release, name), join(out, name));
  files.push({
    name,
    bytes: readFileSync(join(out, name)).length,
    sha256: await sha256File(join(out, name)),
  });
}
const catalog = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).workspaces.catalog;
const info = {
  schema: 1,
  version,
  tag: `v${version}`,
  repository: LINUX_REPO,
  platform: "linux-x64",
  sourceCommit: source,
  workflow: LINUX_WORKFLOW,
  runId: Number(values["run-id"]),
  runAttempt: Number(values["run-attempt"] ?? 1),
  runner: "GitHub-hosted ubuntu-24.04",
  tools: {
    bun: readFileSync(join(ROOT, ".bun-version"), "utf8").trim(),
    node: process.versions.node,
    electron: catalog.electron,
    electronBuilder: catalog["electron-builder"],
  },
  files,
  qualification: {
    packageVerifier: "pass",
    debInstall: "installed on Ubuntu 24.04 and Debian 12; node-pty loaded on Debian 12",
    packagedSmoke:
      "SMOKE OK from the installed .deb and the AppImage, fake agents, temporary stores",
  },
  signing:
    "none: Linux packages carry no publisher signature; each has a GitHub build attestation from this workflow",
};
writeFileSync(join(out, LINUX_BUILD_INFO), `${JSON.stringify(info, null, 2)}\n`);
const check = await checkLinuxBuild(out, {
  version,
  sourceCommit: source,
  runId: values["run-id"],
});
if (check.problems.length) fail(check.problems.join("; "));
for (const { name, sha256 } of files) process.stdout.write(`${sha256}  ${name}\n`);
