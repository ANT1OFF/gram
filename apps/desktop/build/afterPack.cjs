"use strict";
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { findForeignBinaries, listFiles } = require("./native-binary.cjs");

// electron-builder's `Arch` enum, indexed by value.
const ARCH = ["ia32", "x64", "armv7l", "arm64", "universal"];

/**
 * Fails the build when the web app or the third-party notices are missing (electron-builder only
 * warns about a missing extraResources source) or app.asar.unpacked holds a native binary for another platform or arch,
 * strips node-pty's linker debug paths and makes its spawn-helper executable on macOS, and fails a
 * Linux package whose sherpa-onnx isn't the TTS-free build in tools/sherpa-onnx (the npm package's
 * carries text-to-speech).
 *
 * @param {import("app-builder-lib").AfterPackContext} context
 */
exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName === "mas" ? "darwin" : context.electronPlatformName;
  const arch = ARCH[context.arch];
  const resources =
    platform === "darwin"
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Resources",
        )
      : path.join(context.appOutDir, "resources");
  const unpacked = path.join(resources, "app.asar.unpacked");

  if (!fs.existsSync(path.join(resources, "web", "index.html"))) {
    throw new Error(
      "the web app is missing from the package: build it first with `bun run --filter @gram/web build`",
    );
  }

  // electron-builder only warns about a missing extraResources source, too.
  const notices = path.join(resources, "THIRD-PARTY-NOTICES.txt");
  if (!fs.existsSync(notices) || fs.statSync(notices).size === 0) {
    throw new Error(
      "THIRD-PARTY-NOTICES.txt is missing from the package: `bun run build` generates it (tools/notices/generate.mjs)",
    );
  }

  const foreign = findForeignBinaries(unpacked, platform, arch);
  if (foreign.length > 0) {
    const list = foreign
      .map((b) => `  ${path.relative(unpacked, b.file)} (${b.platform}-${b.arch})`)
      .join("\n");
    throw new Error(
      `native binaries for another target in the ${platform}-${arch} package:\n${list}`,
    );
  }

  if (platform === "linux") {
    const modules = path.join(unpacked, "node_modules");
    // The npm sherpa-onnx-linux-x64 carries text-to-speech; the root postinstall
    // (tools/sherpa-onnx/install.mjs) replaces its addon and C APIs with the TTS-free build.
    const build = path.join(__dirname, "..", "..", "..", "tools", "sherpa-onnx", `linux-${arch}`);
    const sums = path.join(build, "SHA256SUMS");
    if (!fs.existsSync(sums))
      throw new Error(`no TTS-free sherpa-onnx build for linux-${arch}: ${build}`);
    const sherpa = path.join(modules, `sherpa-onnx-linux-${arch}`);
    const differ = fs
      .readFileSync(sums, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(/\s+\*?/))
      .filter(([hash, name]) => {
        const file = path.join(sherpa, name);
        return (
          !fs.existsSync(file) ||
          createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== hash
        );
      })
      .map(([, name]) => name);
    if (differ.length > 0) {
      throw new Error(
        `sherpa-onnx-linux-${arch} isn't the TTS-free build in tools/sherpa-onnx/linux-${arch} (${differ.join(", ")}): run bun install, whose postinstall puts it in place`,
      );
    }
    // The addon scripts/rebuild-node-pty.mjs compiled here; drop its debug sections, which name the
    // build machine's paths.
    execFileSync(
      "strip",
      ["--strip-debug", path.join(modules, "node-pty", "build", "Release", "pty.node")],
      {
        stdio: "inherit",
      },
    );
    return;
  }
  if (platform !== "darwin") return;
  // Only node-pty's two prebuilds: -S removes the SO/OSO debug map containing upstream build
  // paths, while retaining exports and runtime strings. ONNX's paths are runtime diagnostics,
  // so leave those libraries untouched. afterPack runs before fuses and all release signing.
  const prebuild = path.join(unpacked, "node_modules", "node-pty", "prebuilds", `darwin-${arch}`);
  for (const name of ["pty.node", "spawn-helper"]) {
    execFileSync("/usr/bin/strip", ["-S", path.join(prebuild, name)], { stdio: "inherit" });
  }
  // node-pty's npm tarball ships spawn-helper as 0644, so every spawn fails without this.
  for (const file of listFiles(unpacked)) {
    if (path.basename(file) === "spawn-helper") fs.chmodSync(file, 0o755);
  }
};
