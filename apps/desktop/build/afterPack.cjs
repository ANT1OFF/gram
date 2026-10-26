"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { findForeignBinaries, listFiles } = require("./native-binary.cjs");

// electron-builder's `Arch` enum, indexed by value.
const ARCH = ["ia32", "x64", "armv7l", "arm64", "universal"];

/**
 * Fails the build when the web app or the third-party notices are missing (electron-builder only
 * warns about a missing extraResources source) or app.asar.unpacked holds a native binary for another platform or arch,
 * strips node-pty's linker debug paths and makes its spawn-helper executable on macOS.
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
