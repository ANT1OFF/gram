/** Claude Code's project directory name: non-ASCII-alphanumeric code points become `-`. */
export const encodeCwdExact = (cwd: string): string =>
  Array.from(cwd, (c) => (/^[A-Za-z0-9]$/.test(c) ? c : "-")).join("");
