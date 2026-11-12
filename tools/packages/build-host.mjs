#!/usr/bin/env node
// Builds the worker host as a folder that runs on its own: `gram-host.js`, one CommonJS bundle of
// the host's entry, and a `package.json` naming the two native modules the bundle leaves out, at
// the versions this workspace pins. `npm install --omit=dev` in that folder completes it. The host
// image is this folder; it can also be copied into another image of the same architecture.
//
//   node tools/packages/build-host.mjs <folder>
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

import { hostManifest, NATIVE } from "./lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const target = process.argv[2];
if (target === undefined) throw new Error("Pass the folder to build into");
const out = resolve(target);
const json = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

// The same shape as the desktop app's own host bundle (apps/desktop/proc-worker-build.ts), left
// readable: one file, everything inlined but the native addons.
const result = await build({
  configFile: false,
  logLevel: "error",
  ssr: { noExternal: true },
  build: {
    ssr: true,
    write: false,
    minify: false,
    sourcemap: false,
    rolldownOptions: {
      input: join(root, "packages/server/src/host/main.ts"),
      platform: "node",
      external: [...NATIVE],
      output: { format: "cjs", codeSplitting: false, keepNames: true, comments: { legal: true } },
    },
  },
});
const chunks = (Array.isArray(result) ? result : [result])
  .flatMap((bundle) => bundle.output)
  .filter((chunk) => chunk.type === "chunk");
if (chunks.length !== 1) throw new Error(`Expected one host bundle, got ${chunks.length}`);

const workspace = json("package.json");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "gram-host.js"), chunks[0].code);
writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify(
    hostManifest({
      version: workspace.version,
      engines: { node: workspace.engines.node },
      catalog: workspace.workspaces.catalog,
      manifests: ["git", "server"].map((folder) => json(`packages/${folder}/package.json`)),
    }),
    null,
    2,
  )}\n`,
);
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
// The terminal emulator a kept terminal's old screen is drawn with, where `plain-text.ts` looks
// for it beside the bundle.
cpSync(
  createRequire(join(root, "packages/server/package.json")).resolve("ghostty-web/ghostty-vt.wasm"),
  join(out, "ghostty-vt.wasm"),
);
console.log(`gram-host built in ${out}`);
