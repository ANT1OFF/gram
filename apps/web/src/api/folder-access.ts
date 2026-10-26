import type { FolderAccessDenial } from "@gram/contracts";

/** The typed denial an `InvalidState` carries when the OS refused a read; `undefined` otherwise. */
export function folderAccessDenial(error: unknown): FolderAccessDenial | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if (Reflect.get(error, "_tag") !== "InvalidState") return undefined;
  const access: unknown = Reflect.get(error, "access");
  if (typeof access !== "object" || access === null) return undefined;
  const path: unknown = Reflect.get(access, "path");
  const code: unknown = Reflect.get(access, "code");
  return typeof path === "string" && (code === "EACCES" || code === "EPERM")
    ? { path, code }
    : undefined;
}

/** Shown when the Privacy Settings shortcut couldn't open the pane. */
export const PRIVACY_SETTINGS_FALLBACK =
  "Open System Settings → Privacy & Security → Files & Folders and check Gram's access.";

/** What "Copy diagnostic details" puts on the clipboard: what failed and which app, nothing more. */
export function folderAccessDiagnostics(
  denial: FolderAccessDenial,
  app: { readonly platform: string; readonly bundlePath?: string | undefined },
): string {
  return [
    "Gram folder access",
    `Path: ${denial.path}`,
    `Error: ${denial.code}`,
    `Platform: ${app.platform}`,
    `App: ${app.bundlePath ?? "not the desktop app"}`,
  ].join("\n");
}
