#!/usr/bin/env node
// Puts the text-to-speech-free sherpa-onnx build from tools/sherpa-onnx/darwin-arm64/ over the npm
// sherpa-onnx-darwin-arm64 package, so development, tests and the packaged app all load it. The npm
// build carries TTS, which Gram never uses, and up to 1.13.8 statically linked espeak-ng
// (GPL-3.0-or-later) for it; build-darwin-arm64.sh says how these files are made. Runs as the root postinstall; a no-op where
// the darwin-arm64 package isn't installed.
//
//   node tools/sherpa-onnx/install.mjs
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dirname;
const ROOT = join(HERE, "..", "..");
const BUILD = join(HERE, "darwin-arm64");
const TARGET = join(ROOT, "node_modules", "sherpa-onnx-darwin-arm64");

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** The files the build made, from its SHA256SUMS: [{ name, sha256 }]. */
export function readSums(dir = BUILD) {
  return readFileSync(join(dir, "SHA256SUMS"), "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const [hash, name] = line.split(/\s+\*?/);
      return { name, sha256: hash };
    });
}

/** Copies each built file over `target`'s that differs from it; returns the names it replaced. */
export function install({ build = BUILD, target = TARGET } = {}) {
  if (!existsSync(join(target, "package.json"))) return [];
  const { version } = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
  const built = readFileSync(join(build, "VERSION"), "utf8").trim();
  if (version !== built) {
    throw new Error(
      `tools/sherpa-onnx/darwin-arm64 is sherpa-onnx ${built}, but ${version} is installed: rebuild it with tools/sherpa-onnx/build-darwin-arm64.sh`,
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
  const replaced = install();
  if (replaced.length > 0)
    console.log(`sherpa-onnx-darwin-arm64: installed the TTS-free ${replaced.join(", ")}`);
}
