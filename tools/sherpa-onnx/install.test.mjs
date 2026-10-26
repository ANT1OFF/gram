import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { install, readSums } from "./install.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** A build folder with the given files and SHA256SUMS, and an installed npm package beside it. */
function fixture({ built = "1.13.8", installed = "1.13.8" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gram-sherpa-"));
  const build = join(root, "build");
  const target = join(root, "node_modules", "sherpa-onnx-darwin-arm64");
  mkdirSync(build);
  mkdirSync(target, { recursive: true });
  const files = { "sherpa-onnx.node": "asr-only addon", "libsherpa-onnx-c-api.dylib": "asr-only" };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(build, name), text);
  writeFileSync(
    join(build, "SHA256SUMS"),
    Object.entries(files)
      .map(([name, text]) => `${sha256(text)}  ${name}\n`)
      .join(""),
  );
  writeFileSync(join(build, "VERSION"), `${built}\n`);
  writeFileSync(join(target, "package.json"), JSON.stringify({ version: installed }));
  writeFileSync(join(target, "sherpa-onnx.node"), "npm addon with tts");
  writeFileSync(join(target, "libsherpa-onnx-c-api.dylib"), "npm c api with espeak-ng");
  writeFileSync(join(target, "libonnxruntime.dylib"), "onnxruntime");
  return { root, build, target };
}

describe("install", () => {
  it("replaces the npm package's addon and C API, and leaves ONNX Runtime", () => {
    const { build, target } = fixture();
    expect(install({ build, target }).toSorted()).toEqual([
      "libsherpa-onnx-c-api.dylib",
      "sherpa-onnx.node",
    ]);
    expect(readFileSync(join(target, "sherpa-onnx.node"), "utf8")).toBe("asr-only addon");
    expect(readFileSync(join(target, "libsherpa-onnx-c-api.dylib"), "utf8")).toBe("asr-only");
    expect(readFileSync(join(target, "libonnxruntime.dylib"), "utf8")).toBe("onnxruntime");
    expect(install({ build, target })).toEqual([]);
  });

  it("never writes through a hard link into the package cache", () => {
    const { root, build, target } = fixture();
    const cached = join(root, "cache-c-api.dylib");
    writeFileSync(cached, "cached c api with espeak-ng");
    const installed = join(target, "libsherpa-onnx-c-api.dylib");
    // What a hard-linked install looks like: the package's file is the cache's.
    rmSync(installed);
    linkSync(cached, installed);
    install({ build, target });
    expect(readFileSync(cached, "utf8")).toBe("cached c api with espeak-ng");
    expect(statSync(installed).ino).not.toBe(statSync(cached).ino);
  });

  it("fails when the installed sherpa-onnx is not the version that was built", () => {
    const { build, target } = fixture({ installed: "1.13.9" });
    expect(() => install({ build, target })).toThrow(/rebuild it/);
  });

  it("fails on a built file that does not match its checksum", () => {
    const { build, target } = fixture();
    writeFileSync(join(build, "libsherpa-onnx-c-api.dylib"), "tampered");
    expect(() => install({ build, target })).toThrow(/does not match its SHA256SUMS/);
    // Nothing was copied, not even the files listed before the bad one.
    expect(readFileSync(join(target, "sherpa-onnx.node"), "utf8")).toBe("npm addon with tts");
  });

  it("does nothing where the darwin-arm64 package is not installed", () => {
    const { root, build } = fixture();
    expect(install({ build, target: join(root, "missing") })).toEqual([]);
  });
});

describe("the committed build", () => {
  it("lists the addon and both C APIs, and matches the catalog's sherpa-onnx", () => {
    const build = fileURLToPath(new URL("./darwin-arm64/", import.meta.url));
    expect(readSums(build).map((entry) => entry.name)).toEqual([
      "sherpa-onnx.node",
      "libsherpa-onnx-c-api.dylib",
      "libsherpa-onnx-cxx-api.dylib",
    ]);
    const catalog = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
      .workspaces.catalog;
    expect(readFileSync(join(build, "VERSION"), "utf8").trim()).toBe(catalog["sherpa-onnx-node"]);
  });

  it("records the upstream tag, the TTS-off flags and the toolchain it was built with", () => {
    const info = readFileSync(new URL("./darwin-arm64/BUILD-INFO", import.meta.url), "utf8");
    const version = readFileSync(new URL("./darwin-arm64/VERSION", import.meta.url), "utf8").trim();
    expect(info).toContain(`k2-fsa/sherpa-onnx v${version} (`);
    expect(info).toContain("-DSHERPA_ONNX_ENABLE_TTS=OFF");
    expect(info).toMatch(/^compiler: .+clang/m);
    expect(info).toMatch(/^macOS: .+ SDK /m);
  });
});
