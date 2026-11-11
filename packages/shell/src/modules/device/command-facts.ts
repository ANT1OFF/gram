import { posix } from "node:path";
import { displayCommand } from "@gram/contracts";

/**
 * What a command is made of, as the ask shows it under the command: the programs it runs and the
 * parts of it a person should look at twice. A parse of POSIX shell syntax, done in the main
 * process. Never a verdict: there is no "safe" answer, only facts, and a command it can't read
 * says so.
 */

export type CommandFact =
  /** A program from the lent folder, or a tool that runs the folder's own scripts or hooks. */
  | { readonly kind: "runs-folder-code"; readonly program: string }
  /** `$(…)`, backticks, `<(…)`: output of one command becomes part of another. */
  | { readonly kind: "substitution" }
  /** `$NAME`, `${NAME}`: text decided when it runs, not shown here. */
  | { readonly kind: "expansion"; readonly names: ReadonlyArray<string> }
  /** A program whose name is only known when it runs. */
  | { readonly kind: "program-expanded" }
  /** Where it writes or reads; none when the name is only known when it runs. */
  | { readonly kind: "redirect"; readonly target?: string; readonly writes: boolean }
  | { readonly kind: "pipe-to-interpreter"; readonly program: string }
  | { readonly kind: "elevates"; readonly program: string }
  | { readonly kind: "network"; readonly program: string }
  | { readonly kind: "outside-folder"; readonly path: string }
  /** Text run as a command: `eval`, `sh -c`, `source`, `xargs`. */
  | { readonly kind: "evaluates"; readonly program: string }
  | { readonly kind: "background" }
  | { readonly kind: "here-document" }
  /** `NAME=value program`: the program runs with these set, which can change what it runs. */
  | { readonly kind: "sets-environment"; readonly names: ReadonlyArray<string> }
  /** `cd` somewhere outside the folder, home, or a place only known when it runs. */
  | { readonly kind: "leaves-folder"; readonly to?: string };

export interface CommandFacts {
  /** False when the command isn't one this parse can read whole: it then says so. */
  readonly parsed: boolean;
  /** Every program it names, in order, once each. */
  readonly programs: ReadonlyArray<string>;
  readonly facts: ReadonlyArray<CommandFact>;
}

export interface CommandPlace {
  /** The lent folder's real path. */
  readonly folder: string;
  /** Where the command runs: the folder or a folder in it. */
  readonly cwd: string;
}

/** Tools that run code the folder holds: its scripts, its build files, its tests, its hooks. */
const FOLDER_RUNNERS = new Set([
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
  "bun",
  "bunx",
  "deno",
  "make",
  "gmake",
  "cmake",
  "ninja",
  "just",
  "task",
  "cargo",
  "go",
  "gradle",
  "gradlew",
  "mvn",
  "mvnw",
  "pytest",
  "tox",
  "nox",
  "rake",
  "bundle",
  "composer",
  "mix",
  "dotnet",
  "swift",
  "poetry",
  "pipenv",
  "uv",
  "hatch",
  "pre-commit",
  "jest",
  "vitest",
  "playwright",
  "turbo",
  "nx",
  "lerna",
  // Any git command may run the repository's hooks or a program its config names.
  "git",
]);

/** Interpreters: given a file, they run it; given `-c`, they run the text. */
const INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "node",
  "python",
  "python3",
  "ruby",
  "perl",
  "php",
  "lua",
  "osascript",
  "pwsh",
]);

/** Versioned names too: `python3.12`, `node22`. */
const isInterpreter = (name: string) =>
  INTERPRETERS.has(name) || /^(python|python3|ruby|perl|php|node|lua)[0-9.]+$/.test(name);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** Programs whose first argument is a program in their own language: it can run anything. */
const AWKS = new Set(["awk", "gawk", "mawk", "nawk"]);

const ELEVATORS = new Set(["sudo", "doas", "su", "pkexec", "runas"]);

const NETWORK = new Set([
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "ftp",
  "telnet",
  "socat",
  "http",
  "https",
  "aria2c",
  "gh",
  // These fetch the package they run.
  "npx",
  "bunx",
  "pnpx",
  "uvx",
  "pipx",
]);

const GIT_NETWORK = new Set(["clone", "fetch", "pull", "push", "ls-remote", "submodule", "remote"]);
const INSTALLS = new Set([
  "install",
  "i",
  "add",
  "publish",
  "update",
  "upgrade",
  "ci",
  "get",
  "dlx",
  "exec",
  "x",
]);
/** git's own options before its subcommand that take the next word. */
const GIT_OPTIONS_WITH_VALUES = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--exec-path",
]);

/** Words before a program that run the next word as the program. */
const WRAPPERS = new Set([
  "env",
  "nice",
  "nohup",
  "time",
  "command",
  "builtin",
  "exec",
  "timeout",
  "stdbuf",
  "ionice",
  "xargs",
  "caffeinate",
  "setsid",
  "busybox",
  ...ELEVATORS,
]);

/** A wrapper's short options that take a value, its long options that do, and those that don't. */
const WRAPPER_OPTIONS: Readonly<
  Record<string, { readonly short: string; readonly values?: string; readonly flags?: string }>
> = {
  sudo: {
    short: "ugCDhprtTU",
    values:
      "--user --group --chdir --host --prompt --role --type --close-from --other-user --command-timeout",
    flags:
      "--login --shell --preserve-env --non-interactive --background --edit --stdin --reset-timestamp --remove-timestamp --validate --set-home --askpass --preserve-groups",
  },
  doas: { short: "uC" },
  su: {
    short: "cgGsw",
    values: "--command --group --supp-group --shell --whitelist-environment",
    flags: "--login --preserve-environment --pty --fast",
  },
  env: { short: "uC", values: "--unset --chdir", flags: "--ignore-environment --null" },
  nice: { short: "n", values: "--adjustment" },
  timeout: {
    short: "sk",
    values: "--signal --kill-after",
    flags: "--preserve-status --foreground --verbose",
  },
  ionice: { short: "cnpPu", values: "--class --classdata --pid --pgid --uid" },
  stdbuf: { short: "ioe", values: "--input --output --error" },
  xargs: {
    short: "InPLsdEa",
    values:
      "--max-args --max-procs --max-lines --delimiter --arg-file --replace --eof --max-chars --process-slot-var",
    flags: "--null --no-run-if-empty --verbose --interactive --open-tty --exit",
  },
  exec: { short: "a" },
  setsid: { short: "", flags: "--ctty --fork --wait" },
};

const EVALUATORS = new Set(["eval", "source", ".", "xargs"]);

/** Reserved words after which a command starts. */
const COMMAND_STARTERS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{"]);
/** Words that start syntax this parse doesn't read. */
const UNREAD_STARTERS = new Set(["case", "function", "coproc"]);
const ENDERS = new Set(["fi", "done", "}", "esac"]);

const DEPTH_MOST = 8;

class Unreadable extends Error {}

interface Word {
  /** The word with its quotes taken off, as far as it is known before it runs. */
  readonly text: string;
  /** Part of it is only known when it runs. */
  readonly expands: boolean;
  /** The commands its substitutions run, read where the word is. */
  readonly inner: ReadonlyArray<string>;
  /** It starts with an unquoted `NAME=`: before a program, it sets that program's environment. */
  readonly assigns: boolean;
}

type Token =
  | { readonly kind: "word"; readonly word: Word }
  | { readonly kind: "op"; readonly op: string };

interface Found {
  programs: Array<string>;
  facts: Array<CommandFact>;
  names: Set<string>;
  /** Where the command is by now; unknown after a `cd` to a place only known when it runs. */
  cwd: string | undefined;
}

const OPERATORS = [
  "&>>",
  "<<-",
  ";;",
  "&&",
  "||",
  "|&",
  ">>",
  "<<",
  "<&",
  ">&",
  "<>",
  ">|",
  "&>",
  "|",
  "&",
  ";",
  "(",
  ")",
  "<",
  ">",
  "\n",
];

const REDIRECTS = new Set(["<", ">", ">>", "<&", ">&", "<>", ">|", "&>", "&>>"]);

/** The index just past the `)` that closes a `(` at `from`, minding quotes and nesting. */
const closing = (text: string, from: number, open: string, close: string): number => {
  let depth = 0;
  for (let at = from; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\\") {
      at += 1;
      continue;
    }
    if (char === "'") {
      const end = text.indexOf("'", at + 1);
      if (end < 0) throw new Unreadable();
      at = end;
      continue;
    }
    if (char === '"') {
      at = closingQuote(text, at + 1);
      continue;
    }
    if (char === "`") {
      at = closingBacktick(text, at + 1);
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
  }
  throw new Unreadable();
};

const closingQuote = (text: string, from: number): number => {
  for (let at = from; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\\") at += 1;
    else if (char === '"') return at;
    else if (char === "$" && text[at + 1] === "(") at = closing(text, at + 1, "(", ")") - 1;
    else if (char === "`") at = closingBacktick(text, at + 1);
  }
  throw new Unreadable();
};

const closingBacktick = (text: string, from: number): number => {
  for (let at = from; at < text.length; at += 1) {
    if (text[at] === "\\") at += 1;
    else if (text[at] === "`") return at;
  }
  throw new Unreadable();
};

const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

/** Splits a command into words and operators, reading what substitutions run as it goes. */
const lex = (text: string, found: Found): Array<Token> => {
  const tokens: Array<Token> = [];
  const heredocs: Array<{ delimiter: string; quoted: boolean }> = [];
  let at = 0;
  let word = "";
  let expands = false;
  let inWord = false;
  let inner: Array<string> = [];
  let wordStart = 0;
  const flush = () => {
    if (inWord) {
      const assigns = /^[A-Za-z_][A-Za-z0-9_]*=/.test(text.slice(wordStart));
      tokens.push({ kind: "word", word: { text: word, expands, inner, assigns } });
    }
    word = "";
    expands = false;
    inWord = false;
    inner = [];
  };
  const substitution = (command: string) => {
    found.facts.push({ kind: "substitution" });
    expands = true;
    inner.push(command);
  };
  const dollar = (): void => {
    // At a `$`: a substitution, an arithmetic, a parameter, or a plain `$`.
    const next = text[at + 1];
    // `$'…'` and `$"…"` are bash's own quoting, decoded when it runs.
    if (next === "'" || next === '"') throw new Unreadable();
    if (next === "(" && text[at + 2] === "(") {
      const end = closing(text, at + 1, "(", ")");
      if (text[end - 2] !== ")") {
        // `$((…); …)` is a command substitution of a subshell, which bash reads as one.
        substitution(text.slice(at + 2, end - 1));
        at = end;
        return;
      }
      // Names in arithmetic are read again as arithmetic when it runs, and that can run
      // commands; so can a substitution inside it.
      if (/[A-Za-z_$`]/.test(text.slice(at + 3, end - 2))) throw new Unreadable();
      expands = true;
      at = end;
      return;
    }
    if (next === "(") {
      const end = closing(text, at + 1, "(", ")");
      substitution(text.slice(at + 2, end - 1));
      at = end;
      return;
    }
    if (next === "{") {
      const end = closing(text, at + 1, "{", "}");
      const body = text.slice(at + 2, end - 1);
      // A default, an indirection or a transformation can run commands or read other names.
      if (/[$`@!]|[<>]\(/.test(body)) throw new Unreadable();
      const name = NAME.exec(body)?.[0];
      if (name !== undefined) found.names.add(name);
      expands = true;
      at = end;
      return;
    }
    const name = NAME.exec(text.slice(at + 1))?.[0];
    if (name !== undefined) {
      found.names.add(name);
      expands = true;
      at += 1 + name.length;
      return;
    }
    if (next !== undefined && /[0-9@*#?$!-]/.test(next)) {
      expands = true;
      at += 2;
      return;
    }
    word += "$";
    at += 1;
  };
  while (at < text.length) {
    const char = text[at] ?? "";
    if (!inWord) wordStart = at;
    if (char === "\\") {
      // A backslash and newline join lines; any other character is taken as it is.
      if (text[at + 1] === "\n") {
        at += 2;
        continue;
      }
      if (at + 1 >= text.length) throw new Unreadable();
      word += text[at + 1];
      inWord = true;
      at += 2;
      continue;
    }
    if (char === "'") {
      const end = text.indexOf("'", at + 1);
      if (end < 0) throw new Unreadable();
      word += text.slice(at + 1, end);
      inWord = true;
      at = end + 1;
      continue;
    }
    if (char === '"') {
      inWord = true;
      at += 1;
      while (at < text.length && text[at] !== '"') {
        const quoted = text[at] ?? "";
        if (quoted === "\\" && at + 1 < text.length && '$`"\\\n'.includes(text[at + 1] ?? "")) {
          if (text[at + 1] !== "\n") word += text[at + 1];
          at += 2;
        } else if (quoted === "$") dollar();
        else if (quoted === "`") {
          const end = closingBacktick(text, at + 1);
          substitution(text.slice(at + 1, end));
          at = end + 1;
        } else {
          word += quoted;
          at += 1;
        }
      }
      if (at >= text.length) throw new Unreadable();
      at += 1;
      continue;
    }
    if (char === "$") {
      inWord = true;
      dollar();
      continue;
    }
    if (char === "`") {
      const end = closingBacktick(text, at + 1);
      inWord = true;
      substitution(text.slice(at + 1, end));
      at = end + 1;
      continue;
    }
    if ((char === "<" || char === ">") && text[at + 1] === "(") {
      // A process substitution: its output, or its input, as a file.
      const end = closing(text, at + 1, "(", ")");
      inWord = true;
      substitution(text.slice(at + 2, end - 1));
      at = end;
      continue;
    }
    if (char === "#" && !inWord) {
      const end = text.indexOf("\n", at);
      at = end < 0 ? text.length : end;
      continue;
    }
    if (char === " " || char === "\t") {
      flush();
      at += 1;
      continue;
    }
    const op = OPERATORS.find((candidate) => text.startsWith(candidate, at));
    if (op !== undefined) {
      // A file descriptor written before a redirection belongs to it, not to the words.
      if (REDIRECTS.has(op) && inWord && /^[0-9]+$/.test(word) && !expands) {
        word = "";
        inWord = false;
      }
      flush();
      tokens.push({ kind: "op", op });
      at += op.length;
      if (op === "<<" || op === "<<-") {
        while (text[at] === " " || text[at] === "\t") at += 1;
        const start = at;
        while (at < text.length && !/[\s;&|<>()]/.test(text[at] ?? "")) at += 1;
        const raw = text.slice(start, at);
        const delimiter = raw.replaceAll(/['"\\]/g, "");
        if (delimiter === "") throw new Unreadable();
        heredocs.push({ delimiter, quoted: delimiter !== raw });
        found.facts.push({ kind: "here-document" });
        tokens.push({
          kind: "word",
          word: { text: delimiter, expands: false, inner: [], assigns: false },
        });
      }
      if (op === "\n" && heredocs.length > 0) {
        // The documents' lines follow, each to its delimiter: data, not commands, unless the
        // delimiter is unquoted, when the shell expands what is in them.
        for (const { delimiter, quoted } of heredocs.splice(0)) {
          for (;;) {
            if (at >= text.length) throw new Unreadable();
            const end = text.indexOf("\n", at);
            const line = text.slice(at, end < 0 ? text.length : end);
            at = end < 0 ? text.length : end + 1;
            if (line.replace(/^\t+/, "") === delimiter) break;
            if (quoted) continue;
            if (/`|\$[({]/.test(line)) throw new Unreadable();
            for (const match of line.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g))
              if (match[1] !== undefined) found.names.add(match[1]);
          }
        }
      }
      continue;
    }
    if (char === "{") {
      // `{a,b}` and `{1..3}` are expanded into several words by bash: not read here.
      const rest = /^[^\s;&|<>()]*/.exec(text.slice(at))?.[0] ?? "";
      const close = rest.indexOf("}");
      if (close > 0 && /,|\.\./.test(rest.slice(1, close))) throw new Unreadable();
    }
    word += char;
    inWord = true;
    at += 1;
  }
  if (heredocs.length > 0) throw new Unreadable();
  flush();
  return tokens;
};

const inside = (folder: string, path: string) =>
  path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);

/** The places a word may name: itself, what follows its `=`, and a short option's glued value. */
const placesIn = (text: string): Array<string> => {
  const places = [text];
  const equals = text.indexOf("=");
  if (equals >= 0) places.push(text.slice(equals + 1));
  if (/^-[^-]/.test(text) && text.length > 2) places.push(text.slice(2));
  return places;
};

/** Notes a word that names a place outside the lent folder. */
const pathFacts = (word: Word, found: Found, place: CommandPlace) => {
  if (word.expands) return;
  for (const text of placesIn(word.text)) {
    if (text.startsWith("~")) {
      found.facts.push({ kind: "outside-folder", path: text });
      return;
    }
    if (!text.includes("/") && text !== "..") continue;
    // After a `cd` to a place only known when it runs, any path but the folder's own may be out.
    const resolved =
      found.cwd === undefined
        ? text.startsWith("/")
          ? posix.resolve(text)
          : undefined
        : posix.resolve(found.cwd, text);
    if (resolved === undefined || !inside(place.folder, resolved)) {
      found.facts.push({ kind: "outside-folder", path: text });
      return;
    }
  }
};

const baseName = (program: string) => program.slice(program.lastIndexOf("/") + 1);

/** The first word that isn't an option, past git's own options; and whether `-c` set config. */
const gitSubcommand = (args: ReadonlyArray<Word>) => {
  let configured = false;
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index]?.text ?? "";
    if (GIT_OPTIONS_WITH_VALUES.has(text)) {
      if (text === "-c" || text === "--config-env") configured = true;
      index += 1;
      continue;
    }
    if (text.startsWith("-c") || text.startsWith("--config-env=")) configured = true;
    if (text.startsWith("-")) continue;
    return { sub: text, configured };
  }
  return { sub: undefined, configured };
};

/** Where a `cd` goes: its folder, home, or undefined when only known when it runs. */
const changeFolder = (args: ReadonlyArray<Word>, found: Found, place: CommandPlace) => {
  const target = args.find((arg) => !arg.text.startsWith("-") || arg.text === "-");
  if (target === undefined || target.text === "-" || target.expands) {
    found.facts.push({
      kind: "leaves-folder",
      ...(target === undefined ? { to: "~" } : {}),
    });
    found.cwd = undefined;
    return;
  }
  if (found.cwd === undefined && !target.text.startsWith("/")) return;
  const to = posix.resolve(found.cwd ?? "/", target.text);
  found.cwd = to;
  if (!inside(place.folder, to)) found.facts.push({ kind: "leaves-folder", to: target.text });
};

/**
 * One simple command: its program, what wraps it, and its arguments. Returns the programs it
 * named, wrappers first, so a pipe into `sudo bash` is seen as a pipe into bash.
 */
const simple = (
  words: ReadonlyArray<Word>,
  found: Found,
  place: CommandPlace,
  depth: number,
): Array<string> => {
  const named: Array<string> = [];
  let index = 0;
  // Assignments before the program set its environment.
  const assigned: Array<string> = [];
  while (index < words.length && words[index]?.assigns === true) {
    const text = words[index]?.text ?? "";
    assigned.push(text.slice(0, text.indexOf("=")));
    pathFacts(words[index] as Word, found, place);
    index += 1;
  }
  while (index < words.length) {
    const word = words[index];
    if (word === undefined) break;
    if (word.expands) {
      found.facts.push({ kind: "program-expanded" });
      break;
    }
    const program = word.text;
    const name = baseName(program);
    named.push(name);
    if (!found.programs.includes(program)) found.programs.push(program);
    const args = words.slice(index + 1);
    for (const arg of args) pathFacts(arg, found, place);
    if (program.includes("/")) {
      const resolved =
        found.cwd === undefined && !program.startsWith("/")
          ? undefined
          : posix.resolve(found.cwd ?? "/", program);
      if (resolved !== undefined && inside(place.folder, resolved))
        found.facts.push({ kind: "runs-folder-code", program });
      else found.facts.push({ kind: "outside-folder", path: program });
    }
    if (name === "cd" || name === "pushd" || name === "popd") changeFolder(args, found, place);
    if (ELEVATORS.has(name)) found.facts.push({ kind: "elevates", program: name });
    if (NETWORK.has(name)) found.facts.push({ kind: "network", program: name });
    const git = name === "git" ? gitSubcommand(args) : undefined;
    const sub = git === undefined ? args.find((arg) => !arg.text.startsWith("-"))?.text : git.sub;
    if (git?.configured === true) found.facts.push({ kind: "evaluates", program: "git -c" });
    if (git !== undefined && sub !== undefined && GIT_NETWORK.has(sub))
      found.facts.push({ kind: "network", program: `git ${sub}` });
    if (
      ["npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "cargo", "go", "gem", "brew"].includes(
        name,
      ) &&
      sub !== undefined &&
      INSTALLS.has(sub)
    )
      found.facts.push({ kind: "network", program: `${name} ${sub}` });
    if (FOLDER_RUNNERS.has(name)) found.facts.push({ kind: "runs-folder-code", program: name });
    if (EVALUATORS.has(name)) {
      found.facts.push({ kind: "evaluates", program: name });
      if (args.some((arg) => arg.expands)) found.facts.push({ kind: "program-expanded" });
    }
    if (AWKS.has(name)) found.facts.push({ kind: "evaluates", program: name });
    if (name === "find") {
      // `-exec` and its kin run a program for each file found.
      for (let at = 0; at < args.length; at += 1) {
        if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[at]?.text ?? "")) continue;
        const stop = args.findIndex(
          (arg, after) => after > at && (arg.text === ";" || arg.text === "+"),
        );
        if (stop < 0) throw new Unreadable();
        named.push(...simple(args.slice(at + 1, stop), found, place, depth));
        at = stop;
      }
    }
    if (isInterpreter(name)) {
      const shell = SHELLS.has(name);
      const flag = args.findIndex((arg) =>
        shell
          ? /^-[a-zA-Z]*c$/.test(arg.text)
          : /^-[a-zA-Z]*[ceEpr]$/.test(arg.text) || /^--(eval|print|command)(=|$)/.test(arg.text),
      );
      if (flag >= 0) {
        found.facts.push({ kind: "evaluates", program: name });
        const script = args[flag + 1];
        if (script !== undefined && shell) {
          if (script.expands) found.facts.push({ kind: "program-expanded" });
          else walk(script.text, found, place, depth + 1);
        }
      } else if (sub !== undefined)
        found.facts.push({ kind: "runs-folder-code", program: `${name} ${sub}` });
    }
    if (!WRAPPERS.has(name)) break;
    // The wrapped program comes after the wrapper's options, and for `env`, its assignments.
    const options = WRAPPER_OPTIONS[name] ?? { short: "" };
    index += 1;
    while (index < words.length) {
      const next = words[index]?.text ?? "";
      if (next === "--") {
        index += 1;
        break;
      }
      if (next.startsWith("--")) {
        const [option = "", value] = next.split("=", 2);
        // An option this parse doesn't know may take the program's place: not read.
        if (option === "--split-string") throw new Unreadable();
        if ((options.values ?? "").split(" ").includes(option)) {
          if (name === "su" && option === "--command")
            evaluated(value ?? words[index + 1]?.text, name, found, place, depth);
          index += value === undefined ? 2 : 1;
          continue;
        }
        if ((options.flags ?? "").split(" ").includes(option) && value === undefined) {
          index += 1;
          continue;
        }
        throw new Unreadable();
      }
      if (next.startsWith("-") && next.length > 1) {
        // A cluster of short options; one that takes a value takes the rest, or the next word.
        if (name === "env" && next.includes("S")) throw new Unreadable();
        let taken = 1;
        for (let at = 1; at < next.length; at += 1) {
          if (!options.short.includes(next[at] ?? "")) continue;
          const value = at === next.length - 1 ? words[index + 1]?.text : next.slice(at + 1);
          if (at === next.length - 1) taken = 2;
          if (name === "su" && next[at] === "c") evaluated(value, name, found, place, depth);
          break;
        }
        index += taken;
        continue;
      }
      if (name === "env" && words[index]?.assigns === true) {
        assigned.push(next.slice(0, next.indexOf("=")));
        index += 1;
        continue;
      }
      if (name === "timeout" && /^[0-9.]+[smhd]?$/.test(next)) {
        index += 1;
        continue;
      }
      break;
    }
  }
  if (assigned.length > 0) found.facts.push({ kind: "sets-environment", names: assigned });
  return named;
};

/** Text a wrapper runs as a command, such as `su -c`. */
const evaluated = (
  text: string | undefined,
  program: string,
  found: Found,
  place: CommandPlace,
  depth: number,
) => {
  found.facts.push({ kind: "evaluates", program });
  if (text !== undefined) walk(text, found, place, depth + 1);
};

/** Reads a whole command line: its lists, pipelines and simple commands. */
const walk = (text: string, found: Found, place: CommandPlace, depth: number) => {
  if (depth > DEPTH_MOST) throw new Unreadable();
  const tokens = lex(text, found);
  const readInner = (word: Word) => {
    for (const command of word.inner) walk(command, found, place, depth + 1);
  };
  let words: Array<Word> = [];
  let afterPipe = false;
  let redirect: string | undefined;
  let skipping: "for" | undefined;
  const end = () => {
    if (words.length > 0) {
      const named = simple(words, found, place, depth);
      for (const word of words) readInner(word);
      const program = named.find(isInterpreter);
      if (afterPipe && program !== undefined)
        found.facts.push({ kind: "pipe-to-interpreter", program });
    }
    words = [];
  };
  for (const token of tokens) {
    if (token.kind === "op") {
      if (redirect !== undefined) throw new Unreadable();
      if (REDIRECTS.has(token.op) || token.op === "<<" || token.op === "<<-") {
        redirect = token.op;
        continue;
      }
      if (skipping === "for" && (token.op === ";" || token.op === "\n")) {
        skipping = undefined;
        continue;
      }
      end();
      if (token.op === "&") found.facts.push({ kind: "background" });
      afterPipe = token.op === "|" || token.op === "|&";
      continue;
    }
    if (redirect !== undefined) {
      const writes = redirect.includes(">");
      if (redirect !== "<<" && redirect !== "<<-" && !/^[0-9-]+$/.test(token.word.text)) {
        found.facts.push({
          kind: "redirect",
          ...(token.word.expands ? {} : { target: token.word.text }),
          writes,
        });
        pathFacts(token.word, found, place);
      }
      readInner(token.word);
      redirect = undefined;
      continue;
    }
    if (skipping === "for") {
      readInner(token.word);
      if (token.word.text === "do") skipping = undefined;
      continue;
    }
    if (words.length === 0 && !token.word.expands) {
      if (UNREAD_STARTERS.has(token.word.text)) throw new Unreadable();
      if (token.word.text === "for" || token.word.text === "select") {
        skipping = "for";
        continue;
      }
      if (COMMAND_STARTERS.has(token.word.text) || ENDERS.has(token.word.text)) continue;
    }
    words.push(token.word);
  }
  if (redirect !== undefined) throw new Unreadable();
  end();
};

/** The facts about a command, for the ask. */
export const commandFacts = (command: string, place: CommandPlace): CommandFacts => {
  const found: Found = { programs: [], facts: [], names: new Set(), cwd: place.cwd };
  try {
    walk(command, found, place, 0);
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    return { parsed: false, programs: found.programs, facts: dedupe(found) };
  }
  return { parsed: true, programs: found.programs, facts: dedupe(found) };
};

const dedupe = (found: Found): ReadonlyArray<CommandFact> => {
  const seen = new Set<string>();
  const facts: Array<CommandFact> = [];
  for (const fact of found.facts) {
    const key = JSON.stringify(fact);
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push(fact);
  }
  if (found.names.size > 0) facts.push({ kind: "expansion", names: [...found.names].toSorted() });
  return facts;
};

/**
 * A word from the command as a fact names it: hidden characters drawn as codes, and in quotes
 * when it holds anything but plain name characters, so it can't read as the fact's own words.
 */
export const shownWord = (text: string): string => {
  const flat = displayCommand(text)
    .pieces.map((piece) => (piece.kind === "newline" ? "\\n" : piece.text))
    .join("");
  return /^[A-Za-z0-9._/+@:%=~-]+$/.test(flat) ? flat : `"${flat}"`;
};

/** How the ask words a fact. Plain text, drawn as text. */
export const commandFactText = (fact: CommandFact): string => {
  switch (fact.kind) {
    case "runs-folder-code":
      return `Runs code from this folder (${shownWord(fact.program)})`;
    case "substitution":
      return "Runs a command inside the command";
    case "expansion":
      return `Uses values set when it runs: ${fact.names.join(", ")}`;
    case "program-expanded":
      return "Runs a program whose name is only known when it runs";
    case "redirect": {
      const target =
        fact.target === undefined ? "a file named when it runs" : shownWord(fact.target);
      return fact.writes ? `Writes to ${target}` : `Reads from ${target}`;
    }
    case "pipe-to-interpreter":
      return `Passes text to ${shownWord(fact.program)} to run`;
    case "elevates":
      return `Asks for more rights (${shownWord(fact.program)})`;
    case "network":
      return `Uses the network (${shownWord(fact.program)})`;
    case "outside-folder":
      return `Names a place outside the folder: ${shownWord(fact.path)}`;
    case "evaluates":
      return `Runs text as a command (${shownWord(fact.program)})`;
    case "background":
      return "Leaves something running in the background";
    case "here-document":
      return "Carries text written into the command";
    case "sets-environment":
      return `Sets ${fact.names.join(", ")} for the program it runs, which can change what runs`;
    case "leaves-folder":
      return fact.to === undefined
        ? "Moves to a folder only known when it runs"
        : fact.to === "~"
          ? "Moves to your home folder"
          : `Moves out of this folder, to ${shownWord(fact.to)}`;
  }
};
