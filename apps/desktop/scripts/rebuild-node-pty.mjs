#!/usr/bin/env node
// Compiles node-pty's addon against the pinned Electron's headers, for a Linux package.
//
// node-pty 1.1.0 ships prebuilds for macOS and Windows only, so on Linux its install hook compiles
// build/Release/pty.node against the Node that ran `bun install`. The addon is N-API, which would
// load in Electron too, but packaging builds it against the Electron it ships with, as
// @electron/rebuild would, so the package never depends on which Node did the install.
// electron-builder.yml keeps `npmRebuild: false` for every platform: macOS and Windows still ship
// node-pty's own prebuilds untouched, and this runs only as the Linux packaging step before it.
//
// Needs Python 3, make and a C++ compiler; downloads Electron's headers once into node-gyp's cache.
//
//   node scripts/rebuild-node-pty.mjs [--arch x64]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { arch: { type: "string", default: process.arch } } });

if (process.platform !== "linux") {
  console.error(
    "rebuild-node-pty: only Linux packages compile node-pty; macOS and Windows ship its prebuilds",
  );
  process.exit(2);
}

const require = createRequire(import.meta.url);
const ptyDir = path.dirname(require.resolve("node-pty/package.json"));
const electron = JSON.parse(
  fs.readFileSync(require.resolve("electron/package.json"), "utf8"),
).version;
// The root's exact node-gyp devDependency (bunfig.toml hoists it for native hooks).
const nodeGyp = createRequire(path.resolve(import.meta.dirname, "../../../package.json")).resolve(
  "node-gyp/bin/node-gyp.js",
);

console.log(`node-pty: compiling for Electron ${electron} linux-${values.arch}`);
execFileSync(
  process.execPath,
  [
    nodeGyp,
    "rebuild",
    `--target=${electron}`,
    `--arch=${values.arch}`,
    "--dist-url=https://electronjs.org/headers",
  ],
  {
    cwd: ptyDir,
    stdio: "inherit",
    // node-gyp reads npm_config_* as its own options; none from the caller's install may leak in.
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)),
    ),
  },
);

const addon = path.join(ptyDir, "build", "Release", "pty.node");
if (!fs.existsSync(addon)) {
  console.error(`rebuild-node-pty: node-gyp finished without ${addon}`);
  process.exit(1);
}
// node-gyp records the headers it compiled against; they must be Electron's, not the host Node's.
const { nodedir } = JSON.parse(
  fs.readFileSync(path.join(ptyDir, "build", "config.gypi"), "utf8").replace(/^#.*$/gm, ""),
).variables;
if (path.basename(nodedir) !== electron) {
  console.error(
    `rebuild-node-pty: compiled against ${nodedir}, not Electron ${electron}'s headers`,
  );
  process.exit(1);
}
console.log(`node-pty: ${path.relative(process.cwd(), addon)} built for Electron ${electron}`);
