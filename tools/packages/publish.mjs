#!/usr/bin/env node
// Publishes the tarballs `pack.mjs` made to one registry. Only the packages workflow runs this
// for real; by hand it is for `--dry-run`.
//
//   node tools/packages/publish.mjs --registry https://npm.pkg.github.com [--dry-run]
//
// A canary is tagged `canary` and a release `latest`. A version the registry already has is
// left alone, so a rerun finishes what an earlier run started. The token, when the registry
// needs one, is read from NODE_AUTH_TOKEN by npm itself and never written anywhere.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { distTag, publishOrder } from "./lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { values } = parseArgs({
  options: {
    registry: { type: "string" },
    out: { type: "string", default: "out/packages" },
    provenance: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});
if (values.registry === undefined) throw new Error("Pass --registry");
const registry = new URL(values.registry);
if (registry.protocol !== "https:") throw new Error("The registry must be an https URL");

const out = resolve(root, values.out);
const packed = JSON.parse(readFileSync(join(out, "packages.json"), "utf8"));
const tag = distTag(packed);

const config = mkdtempSync(join(tmpdir(), "gram-publish-"));
try {
  // npm expands the variable when it reads the file: the file itself holds no token.
  const npmrc = join(config, "npmrc");
  writeFileSync(
    npmrc,
    `registry=${registry.href}\n//${registry.host}${registry.pathname}:_authToken=\${NODE_AUTH_TOKEN}\n`,
  );
  const npm = (args, options = {}) =>
    execFileSync("npm", [...args, "--userconfig", npmrc, "--registry", registry.href], {
      cwd: config,
      encoding: "utf8",
      env: { ...process.env, NODE_AUTH_TOKEN: process.env["NODE_AUTH_TOKEN"] ?? "" },
      ...options,
    });
  const has = (name, version) => {
    try {
      return npm(["view", `${name}@${version}`, "version"], {
        stdio: ["ignore", "pipe", "ignore"],
      }).includes(version);
    } catch {
      // Not there, or the package has never been published.
      return false;
    }
  };

  for (const entry of publishOrder(packed.packages)) {
    const tarball = join(out, entry.tarball);
    const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    if (sha256 !== entry.sha256) throw new Error(`${entry.tarball} changed since it was packed`);
    if (!values["dry-run"] && has(entry.name, entry.version)) {
      console.log(`${entry.name}@${entry.version} is already published`);
      continue;
    }
    npm(
      [
        "publish",
        tarball,
        "--tag",
        tag,
        "--access",
        "public",
        ...(values.provenance ? ["--provenance"] : []),
        ...(values["dry-run"] ? ["--dry-run"] : []),
      ],
      { stdio: "inherit" },
    );
    console.log(
      `${values["dry-run"] ? "would publish" : "published"} ${entry.name}@${entry.version} as ${tag}`,
    );
  }
} finally {
  rmSync(config, { recursive: true, force: true });
}
