import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** The notices `tools/notices/generate.mjs` writes at build time and electron-builder ships. */
const NOTICES_FILE = "THIRD-PARTY-NOTICES.txt";

/**
 * Where the third-party notices are: in Resources/ when packaged, else where the build wrote them,
 * from the desktop app's folder.
 */
export function noticesPath(app: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly appPath: string;
}): string {
  return app.isPackaged
    ? join(app.resourcesPath, NOTICES_FILE)
    : join(app.appPath, "..", "..", "out", "notices", NOTICES_FILE);
}

/** Opens the notices in the system's viewer; false when they're missing or won't open. */
export async function openAcknowledgements(
  path: string,
  openPath: (path: string) => Promise<string>,
): Promise<boolean> {
  if (!existsSync(path) || statSync(path).size === 0) return false;
  // Electron's `shell.openPath` resolves with an error message, empty on success.
  return (await openPath(path)) === "";
}
