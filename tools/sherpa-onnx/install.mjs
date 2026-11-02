#!/usr/bin/env node
// Puts the text-to-speech-free sherpa-onnx builds from tools/sherpa-onnx/<platform>/ over the npm
// sherpa-onnx-<platform> packages (darwin-arm64 and linux-x64), so development, tests and the
// packaged app all load them. The npm builds carry TTS, which Gram never uses, and up to 1.13.8
// statically linked espeak-ng (GPL-3.0-or-later) for it; build-darwin-arm64.sh and
// build-linux-x64.sh say how these files are made. Runs as the root postinstall; a no-op for a
// platform whose npm package isn't installed.
//
//   node tools/sherpa-onnx/install.mjs
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync } from "node:fs";
import { basename, join } from "node:path";

const HERE = import.meta.dirname;
const ROOT = join(HERE, "..", "..");
/** The platforms Gram builds sherpa-onnx for: each folder here replaces the npm package's files. */
export const PLATFORMS = ["darwin-arm64", "linux-x64"];

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** The files the build made, from its SHA256SUMS: [{ name, sha256 }]. */
export function readSums(dir) {
  return readFileSync(join(dir, "SHA256SUMS"), "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const [hash, name] = line.split(/\s+\*?/);
      return { name, sha256: hash };
    });
}

/**
 * Copies each file of the build in `build` over the npm package's in `target` that differs from it;
 * returns the names it replaced.
 */
export function install({ build, target }) {
  if (!existsSync(join(target, "package.json"))) return [];
  const { version } = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
  const built = readFileSync(join(build, "VERSION"), "utf8").trim();
  if (version !== built) {
    throw new Error(
      `tools/sherpa-onnx/${basename(build)} is sherpa-onnx ${built}, but ${version} is installed: rebuild it with tools/sherpa-onnx/build-${basename(build)}.sh`,
    );
  }
  // Every built file is checked before any is copied, so a bad one never leaves a mix behind.
  const sums = readSums(build);
  for (const { name, sha256: expected } of sums) {
    if (sha256(join(build, name)) !== expected)
      throw new Error(`${join(build, name)} does not match its SHA256SUMS line`);
  }
  const replaced = [];
  for (const { name, sha256: expected } of sums) {
    const to = join(target, name);
    if (existsSync(to) && sha256(to) === expected) continue;
    // A new file renamed into place: the installed one can be a hard link into Bun's cache, which
    // writing through would change for every install.
    const staged = `${to}.gram-${process.pid}`;
    copyFileSync(join(build, name), staged);
    renameSync(staged, to);
    replaced.push(name);
  }
  return replaced;
}

if (import.meta.main) {
  for (const platform of PLATFORMS) {
    const replaced = install({
      build: join(HERE, platform),
      target: join(ROOT, "node_modules", `sherpa-onnx-${platform}`),
    });
    if (replaced.length > 0)
      console.log(`sherpa-onnx-${platform}: installed the TTS-free ${replaced.join(", ")}`);
  }
}
