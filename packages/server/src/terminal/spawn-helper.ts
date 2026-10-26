import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

let checked = false;

/**
 * node-pty's npm tarball ships `spawn-helper` without the exec bit, and pnpm doesn't run its install
 * script, so every spawn fails with `posix_spawnp failed`. Packaged builds fix the bit at build time
 * (build/afterPack.cjs); this covers dev and tests. It only chmods when the bit is missing, so a
 * packaged (signed) app is never modified. Best effort: a failure surfaces as the spawn error.
 */
export const ensureSpawnHelperExecutable = (): void => {
  if (checked || process.platform === "win32") return;
  checked = true;
  try {
    // `require` exists in the CommonJS desktop bundle; plain Node runs this file as ESM.
    const resolve =
      typeof require === "function" ? require.resolve : createRequire(import.meta.url).resolve;
    const root = dirname(resolve("node-pty/package.json"));
    const helper = join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper")
      // node-pty runs the helper from the unpacked copy of an asar-packed app.
      .replace(`app.asar${"/"}`, `app.asar.unpacked${"/"}`);
    const mode = statSync(helper).mode;
    if ((mode & 0o111) !== 0o111) chmodSync(helper, mode | 0o755);
  } catch {
    // No prebuild for this platform, or a read-only install.
  }
};
