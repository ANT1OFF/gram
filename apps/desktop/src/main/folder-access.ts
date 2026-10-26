import { isAbsolute } from "node:path";

import type { OpenDialogOptions, OpenDialogReturnValue } from "electron";

/** macOS System Settings → Privacy & Security → Files & Folders. */
export const PRIVACY_FILES_AND_FOLDERS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";

/** Opens the Files & Folders privacy pane; false off macOS or when it can't be opened. */
export async function openPrivacySettings(deps: {
  readonly platform: NodeJS.Platform;
  readonly openExternal: (url: string) => Promise<void>;
}): Promise<boolean> {
  if (deps.platform !== "darwin") return false;
  try {
    await deps.openExternal(PRIVACY_FILES_AND_FOLDERS_URL);
    return true;
  } catch {
    return false;
  }
}

/**
 * The system folder dialog, starting at `input.defaultPath` when that's an absolute path. Resolves
 * with the chosen folder, or `null` when the user cancels.
 */
export async function chooseFolder(
  showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>,
  input: unknown,
): Promise<string | null> {
  const defaultPath: unknown =
    typeof input === "object" && input !== null ? Reflect.get(input, "defaultPath") : undefined;
  const result = await showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    ...(typeof defaultPath === "string" && isAbsolute(defaultPath) ? { defaultPath } : {}),
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

/** The app bundle for diagnostic details: the enclosing `.app` on macOS, else the executable. */
export const bundlePathOf = (exePath: string): string =>
  /^(.*?\.app)(?:[\\/]|$)/.exec(exePath)?.[1] ?? exePath;
