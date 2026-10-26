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

it("never invokes the macOS tool for another target", async () => {
  const { context } = fixture("linux");
  const strip = vi.spyOn(childProcess, "execFileSync").mockReturnValue(Buffer.alloc(0));
  await require("./afterPack.cjs").default(context);
  expect(strip).not.toHaveBeenCalled();
});
