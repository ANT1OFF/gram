/** How a terminal's shell reads a pasted argument. */
export type ShellKind = "posix" | "git-bash" | "powershell" | "cmd";

const baseName = (shell: string) =>
  (shell.split(/[\\/]/).at(-1) ?? shell).toLowerCase().replace(/\.exe$/, "");

/**
 * The quoting rules of `shell`, the executable the server started (`/bin/zsh`, `pwsh.exe`,
 * `C:\Program Files\Git\bin\bash.exe`…). A bash or sh with a Windows path is Git Bash (MSYS).
 */
export function shellKind(shell: string): ShellKind {
  const name = baseName(shell);
  if (name === "powershell" || name === "pwsh") return "powershell";
  if (name === "cmd") return "cmd";
  if ((name === "bash" || name === "sh") && (/\\|\.exe$/i.test(shell) || /^[a-z]:/i.test(shell))) {
    return "git-bash";
  }
  return "posix";
}

const posix = (path: string) =>
  /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;

/** `C:\Users\me\a b` → `/c/Users/me/a b`, as MSYS tools expect. */
const toMsysPath = (path: string) =>
  path
    .replace(/^([A-Za-z]):[\\/]/, (_, drive: string) => `/${drive.toLowerCase()}/`)
    .replaceAll("\\", "/");

/**
 * One path as a single argument for the shell. POSIX shells get single quotes. PowerShell gets single
 * quotes with `''`, so `$` and backticks stay literal. cmd gets double quotes, with each `%` outside
 * them as `^%`, because cmd expands `%NAME%` even inside quotes.
 */
export function quoteShellPath(path: string, kind: ShellKind): string {
  switch (kind) {
    case "posix":
      return posix(path);
    case "git-bash":
      return posix(toMsysPath(path));
    case "powershell":
      return /^[\w:./\\-]+$/.test(path) ? path : `'${path.replaceAll("'", "''")}'`;
    case "cmd":
      return /^[\w:./\\-]+$/.test(path)
        ? path
        : path
            .split("%")
            .map((part) => `"${part}"`)
            .join("^%");
  }
}

/** Dropped paths as the text to type: each quoted for the shell, space-separated, with a trailing space. */
export const formatDroppedPaths = (paths: readonly string[], kind: ShellKind): string =>
  paths.length === 0 ? "" : `${paths.map((path) => quoteShellPath(path, kind)).join(" ")} `;
