// Running Windows batch files (`.cmd` / `.bat`), such as npm's `claude.cmd` shim. Node refuses to
// spawn them without a shell (CVE-2024-27980), so they run through `spawn(…, { shell: true })`,
// which executes `%ComSpec% /d /s /c "<file> <args>"` verbatim. The caret escaping is cross-spawn's,
// which npm tooling relies on.

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** Whether `file` is a batch file that has to run through `cmd.exe` on Windows. */
export const isWindowsBatchFile = (file: string): boolean => /\.(cmd|bat)$/i.test(file);

/** npm's `node_modules\.bin` shims forward `%*` to node, which cmd parses again. */
const isNpmBinShim = (file: string): boolean =>
  /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file);

/** A command path for `cmd.exe /s /c`: every metacharacter caret-escaped, spaces included. */
export const escapeCmdCommand = (command: string): string => command.replace(CMD_META, "^$1");

/**
 * One argument for `cmd.exe /s /c`: backslashes before a quote or the end doubled, quotes
 * backslash-escaped, the whole wrapped in quotes, then every metacharacter caret-escaped (twice for
 * shims that re-parse their arguments).
 */
export const escapeCmdArgument = (arg: string, doubleEscape: boolean): string => {
  // An unanchored backslash-run regex retries every suffix of a long run without a quote, taking
  // quadratic time. Count once; Windows needs twice the run before a quote or the closing quote.
  const chunks = ['"'];
  let backslashes = 0;
  for (const character of arg) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    chunks.push("\\".repeat(character === '"' ? backslashes * 2 + 1 : backslashes), character);
    backslashes = 0;
  }
  chunks.push("\\".repeat(backslashes * 2), '"');
  const quoted = chunks.join("");
  const escaped = quoted.replace(CMD_META, "^$1");
  return doubleEscape ? escaped.replace(CMD_META, "^$1") : escaped;
};

/** `file` and `args` escaped for `spawn(file, args, { shell: true })` on Windows. */
export const batchFileInvocation = (
  file: string,
  args: ReadonlyArray<string>,
): { readonly file: string; readonly args: ReadonlyArray<string> } => {
  const doubleEscape = isNpmBinShim(file);
  return {
    file: escapeCmdCommand(file),
    args: args.map((arg) => escapeCmdArgument(arg, doubleEscape)),
  };
};
