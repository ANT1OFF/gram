import { existsSync } from "node:fs";
import { constants } from "node:os";

export interface ShellCommand {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
}

/** `terminal.shell` profiles on Windows; any other value is an executable name or path. */
export const WINDOWS_SHELLS: Readonly<Record<string, ShellCommand>> = {
  powershell: { file: "powershell.exe", args: [] },
  pwsh: { file: "pwsh.exe", args: [] },
  cmd: { file: "cmd.exe", args: [] },
  "git-bash": { file: "C:\\Program Files\\Git\\bin\\bash.exe", args: ["--login", "-i"] },
};

/**
 * The shell a terminal runs: the requested one, else the user's login shell (`$SHELL -l`), else
 * the `terminal.shell` setting (a profile or an executable) or PowerShell on Windows.
 */
export const shellCommand = (
  requested: string | undefined,
  settingsShell: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): ShellCommand => {
  if (platform === "win32") {
    if (requested !== undefined) return { file: requested, args: [] };
    const profile =
      settingsShell !== undefined && Object.hasOwn(WINDOWS_SHELLS, settingsShell)
        ? WINDOWS_SHELLS[settingsShell]
        : undefined;
    return profile ?? { file: settingsShell ?? "powershell.exe", args: [] };
  }
  const file = requested ?? env["SHELL"] ?? (platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  return { file, args: ["-l"] };
};

export type ShellResolution =
  | { readonly found: true; readonly file: string }
  | { readonly found: false; readonly message: string };

/** What to tell the user when a profile's shell isn't installed where it's looked for. */
const MISSING_SHELL_HINTS: Readonly<Record<string, string>> = {
  "pwsh.exe":
    "PowerShell 7 (pwsh.exe) isn't on PATH. Install PowerShell 7, or choose another terminal shell in Settings.",
  [WINDOWS_SHELLS["git-bash"]!.file]:
    `Git Bash isn't at ${WINDOWS_SHELLS["git-bash"]!.file}. Install Git for Windows, or set the terminal shell in Settings to the full path of bash.exe.`,
};

/**
 * Finds the shell's executable before it's spawned, so a missing shell reads as a clear message
 * rather than ConPTY's "File not found". On Windows a path must exist and a bare name is looked up on
 * `pathValue` (adding `.exe` when it has no extension). Elsewhere the file passes through.
 */
export const resolveShell = (
  file: string,
  platform: NodeJS.Platform,
  pathValue: string,
  exists: (path: string) => boolean = existsSync,
): ShellResolution => {
  if (platform !== "win32") return { found: true, file };
  const names = /\.[A-Za-z0-9]+$/.test(file) ? [file] : [file, `${file}.exe`];
  if (/[\\/]/.test(file)) {
    const hit = names.find((name) => exists(name));
    return hit !== undefined
      ? { found: true, file: hit }
      : {
          found: false,
          message:
            MISSING_SHELL_HINTS[file] ??
            `${file} doesn't exist. Choose an installed terminal shell in Settings.`,
        };
  }
  for (const dir of pathValue.split(";")) {
    if (dir === "") continue;
    for (const name of names) {
      const candidate = `${dir.replace(/[\\/]+$/, "")}\\${name}`;
      if (exists(candidate)) return { found: true, file: candidate };
    }
  }
  return {
    found: false,
    message:
      MISSING_SHELL_HINTS[file] ??
      `${file} isn't on PATH. Choose an installed terminal shell in Settings, or give its full path.`,
  };
};

/** The terminal's environment: the server's, with the probed login-shell PATH and colour support. */
export const terminalEnv = (
  base: Readonly<Record<string, string | undefined>>,
  pathValue: string,
  platform: NodeJS.Platform,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  if (platform !== "win32" && pathValue !== "") env["PATH"] = pathValue;
  env["TERM"] = "xterm-256color";
  env["COLORTERM"] = "truecolor";
  return env;
};

/** node-pty reports the terminating signal as a number; the contract carries its name. */
export const signalName = (signal: number | undefined): string | undefined => {
  if (signal === undefined || signal === 0) return undefined;
  const entry = Object.entries(constants.signals).find(([, value]) => value === signal);
  return entry?.[0] ?? String(signal);
};
