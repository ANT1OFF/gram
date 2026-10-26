import { existsSync } from "node:fs";

import { batchFileInvocation, isWindowsBatchFile, type ShellCheck } from "@gram/contracts";

import { resolveShell, shellCommand, type ShellCommand } from "./shell.ts";

/** `terminal.checkShell`: resolves a `terminal.shell` value the way a new terminal would. */
export const checkShell = (
  shell: string,
  platform: NodeJS.Platform,
  pathValue: string,
  exists: (path: string) => boolean = existsSync,
): ShellCheck => {
  const value = shell.trim();
  if (value === "") return { found: false, message: "Enter a shell profile or a path." };
  const command = shellCommand(undefined, value, {}, "win32");
  // Only Windows reads `terminal.shell`; elsewhere a terminal starts the login shell.
  if (platform !== "win32") return { found: true, file: command.file };
  const resolved = resolveShell(command.file, platform, pathValue, exists);
  return resolved.found
    ? { found: true, file: resolved.file }
    : { found: false, message: resolved.message };
};

/**
 * What node-pty spawns for a resolved shell. A Windows batch file can't be spawned directly, so it
 * runs through `%ComSpec% /d /s /c` with the caret escaping `batchFileInvocation` gives.
 */
export const ptyInvocation = (
  file: string,
  args: ReadonlyArray<string>,
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): ShellCommand => {
  if (platform !== "win32" || !isWindowsBatchFile(file)) return { file, args };
  const invocation = batchFileInvocation(file, args);
  return {
    file: env["ComSpec"] ?? "cmd.exe",
    args: ["/d", "/s", "/c", [invocation.file, ...invocation.args].join(" ")],
  };
};
