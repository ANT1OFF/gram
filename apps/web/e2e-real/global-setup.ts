import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SERVER_BUNDLE, WEB_DIST } from "./harness";

const webDir = fileURLToPath(new URL("..", import.meta.url));
const desktopDir = join(webDir, "../desktop");

const bin = (pkg: string, cwd: string, entry: string) =>
  join(dirname(createRequire(join(cwd, "package.json")).resolve(`${pkg}/package.json`)), entry);

/**
 * Builds what the flows run: the web app the server serves and the bundled server, so a run tests
 * this checkout's code. `GRAM_REAL_E2E_SKIP_BUILD=1` reuses existing builds.
 */
export default function globalSetup(): void {
  // The fake `gh` is a `#!/bin/sh` shim, which Windows can't run, so the server would find the real
  // `gh` further along PATH, signed in, and point it at the fake origin's slug on github.com.
  if (process.platform === "win32") {
    throw new Error("e2e-real runs on Linux/macOS only: its fake gh and shells are sh scripts");
  }
  const skip = process.env["GRAM_REAL_E2E_SKIP_BUILD"] === "1";
  for (const [key, path] of [
    ["GRAM_REAL_E2E_WEB_DIST", join(WEB_DIST, "index.html")],
    ["GRAM_REAL_E2E_SERVER_BUNDLE", SERVER_BUNDLE],
  ]) {
    if (process.env[key!] && (!skip || !existsSync(path!))) {
      throw new Error(
        "Explicit isolated E2E build inputs require existing artifacts and GRAM_REAL_E2E_SKIP_BUILD=1",
      );
    }
  }
  if (!skip || !existsSync(join(WEB_DIST, "index.html"))) {
    execFileSync(process.execPath, [bin("vite", webDir, "bin/vite.js"), "build"], {
      cwd: webDir,
      stdio: ["ignore", "ignore", "inherit"],
    });
  }
  if (!skip || !existsSync(SERVER_BUNDLE)) {
    execFileSync(
      process.execPath,
      [
        bin("electron-vite", desktopDir, "bin/electron-vite.js"),
        "build",
        "-c",
        "electron.vite.server.config.ts",
      ],
      { cwd: desktopDir, stdio: ["ignore", "ignore", "inherit"] },
    );
  }
}
