/**
 * The outward gate's matcher: does a shell command line
 * push, or open, merge or close a PR, by one of the ordinary spellings?
 *
 * Invariant: this is an **accident gate over command spellings, not a boundary**. It reads the
 * command line the way a shell would split it, and recognises `git … push`, `git subtree push`,
 * `gh pr create|new|merge|close`, `gh release create|new`, `gh workflow run` and `gh repo delete`
 * wherever a command can start: after `&&`, `||`, `;`, `|`, `&` or a newline, in a subshell, in
 * `$(…)`, backticks or `<(…)`, behind env assignments, behind `command`, `exec`, `sudo`, `time`,
 * `nohup`, `env`, `nice`, `timeout` and `xargs`, by absolute path, in the script of `sh -c` and
 * `eval`, and in a heredoc fed to a shell. It cannot see `gh api`, `git send-pack`, a git or shell
 * alias, a variable that expands to the command, a script file, or a remote shell, and nothing
 * here should be read as claiming otherwise. It stops the agent that does the ordinary thing
 * unasked, not a prompt-injected one.
 *
 * The gate is levelled (`OutwardGate`), so the matcher also says which kind of outward a command is
 * (`outwardKind`): one that only adds to the remote, or one that can't be taken back.
 *
 * Quoting is honoured, so a word `push` inside a commit message is not a push. A heredoc body is
 * data: with a quoted delimiter it isn't read at all, with an unquoted one only its `$(…)` and
 * backticks are, which is what keeps `git commit -m "$(cat <<'EOF' … EOF)"` with "git push" in the
 * message from asking. Where the reading is in doubt the answer leans toward asking: a heredoc
 * whose terminator is missing is read as commands, a wrapper's unknown options are skipped rather
 * than parsed, `--dry-run` and `--help` still ask, and a line too strange to read at all asks.
 */

import type { OutwardGate } from "./host.ts";

/** Stands in for a substitution's output inside a word, so `$(which git)` never reads as `git`. */
const MARK = "\uFFFC";

interface Heredoc {
  readonly delimiter: string;
  /** `<<-`: leading tabs are stripped from the body and the terminator. */
  readonly stripTabs: boolean;
  /** A quoted delimiter: the shell expands nothing in the body. */
  readonly literal: boolean;
  /** The words of the command the heredoc feeds, by reference: they may still be growing. */
  readonly owner: ReadonlyArray<string>;
}

interface Cursor {
  readonly text: string;
  pos: number;
  /** Heredocs announced on the current line; their bodies start after its newline. */
  readonly heredocs: Array<Heredoc>;
  /** Every simple command found so far, at any nesting depth, as its unquoted words. */
  readonly out: Array<ReadonlyArray<string>>;
}

const REDIRECT_OPERATOR = "<>&|";
const DELIMITER_END = " \t\n;&|()<>";

const readHeredoc = (c: Cursor, owner: ReadonlyArray<string>): void => {
  const stripTabs = c.text.charAt(c.pos) === "-";
  if (stripTabs) c.pos++;
  while (c.pos < c.text.length && " \t".includes(c.text.charAt(c.pos))) c.pos++;
  let delimiter = "";
  let literal = false;
  while (c.pos < c.text.length && !DELIMITER_END.includes(c.text.charAt(c.pos))) {
    const ch = c.text.charAt(c.pos);
    if (ch === "'" || ch === '"') {
      const end = c.text.indexOf(ch, c.pos + 1);
      const stop = end === -1 ? c.text.length : end;
      delimiter += c.text.slice(c.pos + 1, stop);
      c.pos = stop + 1;
      literal = true;
    } else if (ch === "\\") {
      delimiter += c.text.charAt(c.pos + 1);
      c.pos += 2;
      literal = true;
    } else {
      delimiter += ch;
      c.pos++;
    }
  }
  if (delimiter !== "") c.heredocs.push({ delimiter, stripTabs, literal, owner });
};

/** Reads the `$(…)` and backticks of text the shell expands but doesn't run: a heredoc body. */
const collectExpansions = (text: string, out: Cursor["out"]): void => {
  const c: Cursor = { text, pos: 0, heredocs: [], out };
  while (c.pos < text.length) {
    const ch = text.charAt(c.pos);
    if (ch === "\\") c.pos += 2;
    else if (ch === "$" && text.charAt(c.pos + 1) === "(") {
      c.pos += 2;
      parseList(c, ")");
    } else if (ch === "`") {
      c.pos++;
      parseList(c, "`");
    } else c.pos++;
  }
};

/** Skips the bodies of the heredocs the line announced, reading out of them only what runs. */
const skipHeredocs = (c: Cursor): void => {
  for (const heredoc of c.heredocs.splice(0)) {
    const start = c.pos;
    const lines: Array<string> = [];
    let terminated = false;
    while (c.pos < c.text.length && !terminated) {
      const newline = c.text.indexOf("\n", c.pos);
      const end = newline === -1 ? c.text.length : newline;
      const raw = c.text.slice(c.pos, end);
      c.pos = newline === -1 ? c.text.length : newline + 1;
      const line = heredoc.stripTabs ? raw.replace(/^\t+/, "") : raw;
      if (line === heredoc.delimiter) terminated = true;
      else lines.push(line);
    }
    if (!terminated) {
      // No terminator, so where the body ends is a guess: read the rest as commands.
      c.pos = start;
      return;
    }
    const body = lines.join("\n");
    if (feedsShell(heredoc.owner)) collectCommands(body, c.out);
    else if (!heredoc.literal) collectExpansions(body, c.out);
  }
};

const parseDoubleQuoted = (c: Cursor): string => {
  let value = "";
  while (c.pos < c.text.length) {
    const ch = c.text.charAt(c.pos);
    if (ch === '"') {
      c.pos++;
      return value;
    }
    if (ch === "\\") {
      value += c.text.charAt(c.pos + 1);
      c.pos += 2;
    } else if (ch === "$" && c.text.charAt(c.pos + 1) === "(") {
      c.pos += 2;
      parseList(c, ")");
      value += MARK;
    } else if (ch === "`") {
      c.pos++;
      parseList(c, "`");
      value += MARK;
    } else {
      value += ch;
      c.pos++;
    }
  }
  return value;
};

/**
 * Splits a command list into simple commands up to `close` (or the end of the text), recursing into
 * everything that runs a nested list. Not a shell grammar: control operators only separate, and
 * keywords are dropped later, which is enough to find where a command starts.
 */
const parseList = (c: Cursor, close: ")" | "`" | undefined): void => {
  let words: Array<string> = [];
  let word: string | undefined;
  /** The next word is a redirect's target, not an argument. */
  let skipWord = false;
  const endWord = () => {
    if (word === undefined) return;
    if (skipWord) skipWord = false;
    else words.push(word);
    word = undefined;
  };
  const endCommand = () => {
    endWord();
    skipWord = false;
    if (words.length > 0) c.out.push(words);
    words = [];
  };
  const nested = (end: ")" | "`") => {
    parseList(c, end);
    word = (word ?? "") + MARK;
  };

  while (c.pos < c.text.length) {
    const ch = c.text.charAt(c.pos);
    const next = c.text.charAt(c.pos + 1);
    if (ch === close) {
      c.pos++;
      break;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      endWord();
      c.pos++;
    } else if (ch === "\n") {
      endCommand();
      c.pos++;
      skipHeredocs(c);
    } else if (ch === "#" && word === undefined) {
      const newline = c.text.indexOf("\n", c.pos);
      c.pos = newline === -1 ? c.text.length : newline;
    } else if (ch === "\\") {
      if (next !== "\n") word = (word ?? "") + next;
      c.pos += 2;
    } else if (ch === "'") {
      const end = c.text.indexOf("'", c.pos + 1);
      const stop = end === -1 ? c.text.length : end;
      word = (word ?? "") + c.text.slice(c.pos + 1, stop);
      c.pos = stop + 1;
    } else if (ch === '"') {
      c.pos++;
      word = (word ?? "") + parseDoubleQuoted(c);
    } else if (ch === "$" && next === "(") {
      c.pos += 2;
      nested(")");
    } else if (ch === "$" && next === "{") {
      const end = c.text.indexOf("}", c.pos);
      c.pos = end === -1 ? c.text.length : end + 1;
      word = (word ?? "") + MARK;
    } else if (ch === "`") {
      c.pos++;
      nested("`");
    } else if ((ch === "<" || ch === ">") && next === "(") {
      c.pos += 2;
      nested(")");
    } else if (ch === "<" || ch === ">" || (ch === "&" && next === ">")) {
      // A word of digits right before a redirect is its file descriptor, not an argument.
      if (word !== undefined && /^\d+$/.test(word)) word = undefined;
      endWord();
      if (ch === "<" && next === "<" && c.text.charAt(c.pos + 2) !== "<") {
        c.pos += 2;
        readHeredoc(c, words);
      } else {
        c.pos++;
        while (c.pos < c.text.length && REDIRECT_OPERATOR.includes(c.text.charAt(c.pos))) c.pos++;
        skipWord = true;
      }
    } else if (ch === "(") {
      endCommand();
      c.pos++;
      parseList(c, ")");
    } else if (ch === ";" || ch === "&" || ch === "|" || ch === ")") {
      endCommand();
      c.pos++;
    } else {
      word = (word ?? "") + ch;
      c.pos++;
    }
  }
  endCommand();
};

const collectCommands = (text: string, out: Cursor["out"]): void =>
  parseList({ text, pos: 0, heredocs: [], out }, undefined);

/** Shell words that can stand before a command without being one. */
const KEYWORDS: ReadonlySet<string> = new Set([
  "{",
  "}",
  "!",
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "while",
  "until",
  "do",
  "done",
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/**
 * Commands that run the command named by their arguments, with the options of each that take a
 * separate value. Any other option is skipped as a flag, so an unknown value option hides the
 * command behind it; the list covers the ones in common use.
 */
const WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["command", new Set<string>()],
  ["builtin", new Set<string>()],
  ["exec", new Set(["-a"])],
  ["sudo", new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U"])],
  ["time", new Set(["-f", "-o"])],
  ["nohup", new Set<string>()],
  ["env", new Set(["-u", "-C", "-P", "-S"])],
  ["nice", new Set(["-n"])],
  ["timeout", new Set(["-s", "-k"])],
  ["xargs", new Set(["-I", "-n", "-P", "-L", "-s", "-E", "-d", "-a", "-J", "-R"])],
]);

const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** `/usr/bin/git` and `git.exe` are `git`. */
const binaryName = (word: string): string =>
  word.slice(word.lastIndexOf("/") + 1).replace(/\.exe$/i, "");

/** The command's own words, without the keywords, env assignments and wrappers in front of it. */
const unwrap = (raw: ReadonlyArray<string>): ReadonlyArray<string> => {
  let rest = raw;
  for (;;) {
    const head = rest[0];
    if (head === undefined) return rest;
    if (KEYWORDS.has(head) || ASSIGNMENT.test(head)) {
      rest = rest.slice(1);
      continue;
    }
    const name = binaryName(head);
    const valueOptions = WRAPPERS.get(name);
    if (valueOptions === undefined) return rest;
    let i = 1;
    while (i < rest.length && rest[i]!.startsWith("-")) i += valueOptions.has(rest[i]!) ? 2 : 1;
    // `timeout 60 git push`: the duration is positional.
    if (name === "timeout") i++;
    rest = rest.slice(i);
  }
};

const feedsShell = (words: ReadonlyArray<string>): boolean => {
  const head = unwrap(words)[0];
  return head !== undefined && SHELLS.has(binaryName(head));
};

/** git's global options whose value is a separate word; every other one is `--name[=value]`. */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--attr-source",
  "--exec-path",
]);

/** What an outward command does to what it reaches: adds to it, or changes what can't be put back. */
export type OutwardKind = "publish" | "irreversible";

const moreSevere = (
  a: OutwardKind | undefined,
  b: OutwardKind | undefined,
): OutwardKind | undefined =>
  a === "irreversible" || b === "irreversible" ? "irreversible" : (a ?? b);

/**
 * `git push`'s long options that rewrite or delete what the remote holds. git accepts any unique
 * abbreviation of a long option, so `--del` is `--delete`.
 */
const PUSH_REWRITES: ReadonlyArray<string> = [
  "force",
  "force-with-lease",
  "force-if-includes",
  "delete",
  "mirror",
  "prune",
];

/**
 * Whether a push's own arguments make it one the remote can't be put back from: a force, a delete,
 * a mirror or a prune, by option or by refspec (`+src:dst` forces, `:dst` deletes). Option values
 * aren't skipped, so one is read as a refspec: harmless, since only a leading `+` or `:` counts,
 * and a wrong reading asks. A refspec that comes out of a variable or a substitution can't be read
 * and counts as an ordinary push, as does a force configured in the remote (`remote.<name>.mirror`,
 * a `+` in `remote.<name>.push`).
 */
const pushRewrites = (args: ReadonlyArray<string>): boolean => {
  let optionsOver = false;
  for (const arg of args) {
    if (!optionsOver && arg === "--") optionsOver = true;
    else if (!optionsOver && arg.startsWith("--")) {
      const name = arg.slice(2).split("=", 1)[0]!;
      // An abbreviation git would reject as ambiguous (`--f`) asks too, which costs nothing.
      if (name !== "" && PUSH_REWRITES.some((option) => option.startsWith(name))) return true;
    } else if (!optionsOver && arg.startsWith("-") && arg.length > 1) {
      // A cluster of short options: `-fu`. Whatever follows `-o` in it is that option's value.
      if (/[fd]/.test(arg.slice(1).split("o", 1)[0]!)) return true;
    } else if (arg.startsWith("+") || (arg.startsWith(":") && arg.length > 1)) return true;
  }
  return false;
};

const gitKind = (args: ReadonlyArray<string>): OutwardKind | undefined => {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i += GIT_VALUE_OPTIONS.has(args[i]!) ? 2 : 1;
  const subcommand = args[i];
  const rest = args.slice(i + 1);
  if (subcommand === "push") return pushRewrites(rest) ? "irreversible" : "publish";
  // `git subtree push` publishes too, and takes its options on either side of the verb. Its one
  // way to force is a `+` on the ref it pushes to; its `-d` is `--debug`, not a delete.
  if (subcommand !== "subtree" || !rest.includes("push")) return undefined;
  return rest.some((arg) => arg.startsWith("+")) ? "irreversible" : "publish";
};

/**
 * gh's outward verbs by command group; `new` is gh's own alias for `create`. Opening a PR can be
 * undone by closing it. A merge, a close (which can take the branch with it), a release (which
 * tags, and notifies watchers), a workflow run and a repo delete can't be taken back.
 */
const GH_OUTWARD: Readonly<Record<string, ReadonlyMap<string, OutwardKind>>> = {
  pr: new Map<string, OutwardKind>([
    ["create", "publish"],
    ["new", "publish"],
    ["merge", "irreversible"],
    ["close", "irreversible"],
  ]),
  release: new Map<string, OutwardKind>([
    ["create", "irreversible"],
    ["new", "irreversible"],
  ]),
  workflow: new Map<string, OutwardKind>([["run", "irreversible"]]),
  repo: new Map<string, OutwardKind>([["delete", "irreversible"]]),
};

const GH_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-R", "--repo", "--hostname"]);

const ghKind = (args: ReadonlyArray<string>): OutwardKind | undefined => {
  const positional: Array<string> = [];
  for (let i = 0; i < args.length && positional.length < 2; i++) {
    const arg = args[i]!;
    if (GH_VALUE_OPTIONS.has(arg)) i++;
    else if (!arg.startsWith("-")) positional.push(arg);
  }
  const [group, verb] = positional;
  if (group === undefined || verb === undefined || !Object.hasOwn(GH_OUTWARD, group)) {
    return undefined;
  }
  return GH_OUTWARD[group]!.get(verb);
};

const kindOf = (raw: ReadonlyArray<string>): OutwardKind | undefined => {
  const [head, ...args] = unwrap(raw);
  if (head === undefined) return undefined;
  const name = binaryName(head);
  if (name === "git") return gitKind(args);
  if (name === "gh") return ghKind(args);
  if (name === "eval") return outwardKind(args.join(" "));
  if (SHELLS.has(name)) {
    const at = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
    const script = at === -1 ? undefined : args[at + 1];
    return script === undefined ? undefined : outwardKind(script);
  }
  return undefined;
};

/**
 * What a shell command line does outwardly by an ordinary spelling, or `undefined` when it does
 * nothing of the kind. `publish` is a push or opening a PR: more on the remote, nothing lost.
 * `irreversible` is merging or closing a PR, cutting a release, running a workflow, deleting a
 * repo, and a push that rewrites or deletes what the remote holds (`--force`, `-f`,
 * `--force-with-lease`, `--force-if-includes`, `--delete`, `-d`, `--mirror`, `--prune`, a `+`
 * refspec, a `:branch` refspec). A line with several outward commands is as severe as its worst.
 * See the file header for what it can't see.
 */
export const outwardKind = (command: string): OutwardKind | undefined => {
  const commands: Array<ReadonlyArray<string>> = [];
  try {
    collectCommands(command, commands);
    return commands.map(kindOf).reduce(moreSevere, undefined);
  } catch {
    // Nesting deep enough to exhaust the stack isn't a command anyone reads; ask at every level.
    return "irreversible";
  }
};

/**
 * Whether a shell command line pushes, or opens, merges or closes a PR (or cuts a release, runs a
 * workflow, deletes a repo) by an ordinary spelling: `outwardKind` without the kind.
 */
export const isOutwardCommand = (command: string): boolean => outwardKind(command) !== undefined;

/** The level of an `OpenSessionOptions.outwardGate`, whose older spelling is a boolean. */
export const gateLevel = (value: boolean | OutwardGate | undefined): OutwardGate | undefined => {
  if (value === true) return "all";
  return value === false ? undefined : value;
};

/** Whether a gate at `level` asks before a command of `kind`; no gate, or nothing outward, never. */
export const gateAsks = (level: OutwardGate | undefined, kind: OutwardKind | undefined): boolean =>
  level !== undefined && kind !== undefined && (level === "all" || kind === "irreversible");
