import childProcess from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
let dir;
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
  delete require.cache[require.resolve("./afterPack.cjs")];
});

function fixture(platform = "darwin") {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gram-after-pack-"));
  const resources = path.join(
    dir,
    platform === "darwin" ? "Gram.app/Contents/Resources" : "resources",
  );
  fs.mkdirSync(path.join(resources, "web"), { recursive: true });
  fs.writeFileSync(path.join(resources, "web/index.html"), "test");
  fs.writeFileSync(path.join(resources, "THIRD-PARTY-NOTICES.txt"), "test notices");
  const prebuild = path.join(
    resources,
    "app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64",
  );
  fs.mkdirSync(prebuild, { recursive: true });
  for (const name of ["pty.node", "spawn-helper"]) {
    fs.writeFileSync(path.join(prebuild, name), "test prebuild", { mode: 0o644 });
  }
  const onnx = path.join(
    resources,
    "app.asar.unpacked/node_modules/sherpa-onnx-darwin-arm64/libonnxruntime.dylib",
  );
  fs.mkdirSync(path.dirname(onnx), { recursive: true });
  fs.writeFileSync(onnx, "preserve runtime diagnostics");
  return {
    prebuild,
    onnx,
    context: {
      appOutDir: dir,
      electronPlatformName: platform,
      arch: 3,
      packager: { appInfo: { productFilename: "Gram" } },
    },
  };
}

it("strips only macOS node-pty debug maps, leaving ONNX and dependency sources alone", async () => {
  const { context, prebuild, onnx } = fixture();
  const strip = vi.spyOn(childProcess, "execFileSync").mockReturnValue(Buffer.alloc(0));
  await require("./afterPack.cjs").default(context);
  expect(strip.mock.calls).toEqual(
    ["pty.node", "spawn-helper"].map((name) => [
      "/usr/bin/strip",
      ["-S", path.join(prebuild, name)],
      { stdio: "inherit" },
    ]),
  );
  expect(fs.readFileSync(onnx, "utf8")).toBe("preserve runtime diagnostics");
  expect(fs.statSync(path.join(prebuild, "spawn-helper")).mode & 0o777).toBe(0o755);
});

it("fails packaging when debug stripping fails", async () => {
  const { context } = fixture();
  vi.spyOn(childProcess, "execFileSync").mockImplementation(() => {
    throw new Error("strip failed");
  });
  await expect(require("./afterPack.cjs").default(context)).rejects.toThrow("strip failed");
});

it("never invokes a strip tool for Windows", async () => {
  const { context } = fixture("win32");
  const strip = vi.spyOn(childProcess, "execFileSync").mockReturnValue(Buffer.alloc(0));
  await require("./afterPack.cjs").default(context);
  expect(strip).not.toHaveBeenCalled();
});

/** The committed TTS-free linux-x64 build, which a Linux package's sherpa-onnx must match. */
const TTS_FREE = path.resolve(import.meta.dirname, "../../../tools/sherpa-onnx/linux-x64");
const ttsFreeFiles = () =>
  fs
    .readFileSync(path.join(TTS_FREE, "SHA256SUMS"), "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split(/\s+/)[1]);

/** A Linux x64 package's unpacked node_modules, with node-pty's compiled addon and the TTS-free sherpa-onnx. */
function linuxFixture() {
  const { context } = fixture("linux");
  context.arch = 1;
  const modules = path.join(dir, "resources/app.asar.unpacked/node_modules");
  fs.rmSync(path.join(modules, "node-pty/prebuilds"), { recursive: true });
  fs.rmSync(path.join(modules, "sherpa-onnx-darwin-arm64"), { recursive: true });
  const addon = path.join(modules, "node-pty/build/Release/pty.node");
  fs.mkdirSync(path.dirname(addon), { recursive: true });
  fs.writeFileSync(addon, "test addon");
  const sherpa = path.join(modules, "sherpa-onnx-linux-x64");
  fs.mkdirSync(sherpa);
  for (const name of ttsFreeFiles())
    fs.copyFileSync(path.join(TTS_FREE, name), path.join(sherpa, name));
  return { context, modules, addon, sherpa };
}

it("strips the debug sections of Linux's compiled node-pty addon", async () => {
  const { context, addon } = linuxFixture();
  const strip = vi.spyOn(childProcess, "execFileSync").mockReturnValue(Buffer.alloc(0));
  await require("./afterPack.cjs").default(context);
  expect(strip.mock.calls).toEqual([["strip", ["--strip-debug", addon], { stdio: "inherit" }]]);
});

it("fails a Linux package whose sherpa-onnx is the npm build, with text-to-speech", async () => {
  const { context, sherpa } = linuxFixture();
  fs.writeFileSync(path.join(sherpa, "libsherpa-onnx-c-api.so"), "npm c api with tts");
  const strip = vi.spyOn(childProcess, "execFileSync").mockReturnValue(Buffer.alloc(0));
  await expect(require("./afterPack.cjs").default(context)).rejects.toThrow(
    "sherpa-onnx-linux-x64 isn't the TTS-free build in tools/sherpa-onnx/linux-x64 (libsherpa-onnx-c-api.so)",
  );
  expect(strip).not.toHaveBeenCalled();
});

it("fails a Linux package without sherpa-onnx", async () => {
  const { context, sherpa } = linuxFixture();
  fs.rmSync(sherpa, { recursive: true });
  vi.spyOn(childProcess, "execFileSync").mockReturnValue(Buffer.alloc(0));
  await expect(require("./afterPack.cjs").default(context)).rejects.toThrow(
    "(sherpa-onnx.node, libsherpa-onnx-c-api.so, libsherpa-onnx-cxx-api.so)",
  );
});
