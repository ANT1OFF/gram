import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { UPDATE_DIR_PREFIX } from "./config.ts";

/** Whether a temp-dir entry name is one of the updater's per-download installer dirs. */
export function isUpdateDirName(name: string): boolean {
  return name.startsWith(UPDATE_DIR_PREFIX);
}

/**
 * Best-effort removal of leftover installer dirs under `temp` older than `minAgeMs`. The success
 * path deliberately leaves its dir behind (the installer runs from it as the app exits), so this
 * runs at boot and before every download. Entries are classified without following symlinks, and
 * a failure (a locked file) just keeps that dir until a later sweep. Resolves with the count
 * removed.
 */
export async function sweepStaleUpdateDirs(
  temp: string,
  minAgeMs: number,
  now: number = Date.now(),
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(temp);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!isUpdateDirName(name)) continue;
    const path = join(temp, name);
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || now - stat.mtimeMs < minAgeMs) continue;
      await rm(path, { recursive: true, force: true, maxRetries: 3 });
      removed++;
    } catch {
      // Left for a later sweep.
    }
  }
  return removed;
}
