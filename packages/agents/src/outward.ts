import type { OutwardGate } from "./host.ts";

const MARK = "\uFFFC";

interface Heredoc {
  readonly delimiter: string;
  readonly stripTabs: boolean;
  readonly literal: boolean;
  readonly owner: ReadonlyArray<string>;
}

interface Cursor {
  readonly text: string;
  pos: number;
  readonly heredocs: Array<Heredoc>;
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

const parseList = (c: Cursor, close: ")" | "`" | undefined): void => {
  let words: Array<string> = [];
  let word: string | undefined;
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

const binaryName = (word: string): string =>
  word.slice(word.lastIndexOf("/") + 1).replace(/\.exe$/i, "");

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
    if (name === "timeout") i++;
    rest = rest.slice(i);
  }
};

const feedsShell = (words: ReadonlyArray<string>): boolean => {
  const head = unwrap(words)[0];
  return head !== undefined && SHELLS.has(binaryName(head));
};

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

const PUSH_REWRITES: ReadonlyArray<string> = [
  "force",
  "force-with-lease",
  "force-if-includes",
  "delete",
  "mirror",
  "prune",
];

const pushRewrites = (args: ReadonlyArray<string>): boolean => {
  let optionsOver = false;
  for (const arg of args) {
    if (!optionsOver && arg === "--") optionsOver = true;
    else if (!optionsOver && arg.startsWith("--")) {
      const name = arg.slice(2).split("=", 1)[0]!;
      if (name !== "" && PUSH_REWRITES.some((option) => option.startsWith(name))) return true;
    } else if (!optionsOver && arg.startsWith("-") && arg.length > 1) {
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
  if (subcommand !== "subtree" || !rest.includes("push")) return undefined;
  return rest.some((arg) => arg.startsWith("+")) ? "irreversible" : "publish";
};

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
    return "irreversible";
  }
};

const PUSH_CONFIG = /^remote\..+\.(?:push|mirror)(?:=|$)/i;

const configuresPush = (args: ReadonlyArray<string>): boolean => {
  let i = 0;
  for (
    ;
    i < args.length && args[i]!.startsWith("-");
    i += GIT_VALUE_OPTIONS.has(args[i]!) ? 2 : 1
  ) {
    const arg = args[i]!;
    if (arg === "-c" && PUSH_CONFIG.test(args[i + 1] ?? "")) return true;
    if (arg.startsWith("--config-env=") && PUSH_CONFIG.test(arg.slice("--config-env=".length)))
      return true;
    if (arg === "--config-env" && PUSH_CONFIG.test(args[i + 1] ?? "")) return true;
  }
  const [subcommand, ...rest] = args.slice(i);
  if (subcommand === "config") return rest.some((arg) => PUSH_CONFIG.test(arg));
  if (subcommand === "remote") return rest.some((arg) => arg.startsWith("--mirror"));
  return false;
};

const forcesOf = (raw: ReadonlyArray<string>): boolean => {
  const [head, ...args] = unwrap(raw);
  if (head === undefined) return false;
  const name = binaryName(head);
  if (name === "git") return gitKind(args) === "irreversible" || configuresPush(args);
  if (name === "eval") return isForcePush(args.join(" "));
  if (SHELLS.has(name)) {
    const at = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
    const script = at === -1 ? undefined : args[at + 1];
    return script !== undefined && isForcePush(script);
  }
  return false;
};

/**
 * Whether a shell command line pushes over or deletes what a remote holds by an ordinary spelling:
 * a `git push` that `outwardKind` calls `irreversible` (`--force`, `-f`, `--force-with-lease`, a
 * `+` refspec, `--delete`, a `:branch` refspec, `--mirror`, `--prune`), or a line that sets a
 * remote's `push` refspecs or `mirror` itself (`git -c …`, `git config …`, `git remote add
 * --mirror`). A decision about the push is asked as a force push then; a line too strange to read
 * counts as one. A remote's push config set beforehand, or a git alias, isn't in the line.
 */
export const isForcePush = (command: string): boolean => {
  const commands: Array<ReadonlyArray<string>> = [];
  try {
    collectCommands(command, commands);
    return commands.some(forcesOf);
  } catch {
    return true;
  }
};

/** What an outward command does, named: for a decision asked about the command (`outwardActions`). */
export type OutwardAction =
  | "push"
  | "pr.open"
  | "pr.merge"
  | "pr.close"
  | "release"
  | "workflow.run"
  | "repo.delete";

const GH_ACTIONS: Readonly<Record<string, OutwardAction>> = {
  "pr create": "pr.open",
  "pr new": "pr.open",
  "pr merge": "pr.merge",
  "pr close": "pr.close",
  "release create": "release",
  "release new": "release",
  "workflow run": "workflow.run",
  "repo delete": "repo.delete",
};

const actionsOf = (raw: ReadonlyArray<string>): ReadonlyArray<OutwardAction> | undefined => {
  const [head, ...args] = unwrap(raw);
  if (head === undefined) return [];
  const name = binaryName(head);
  if (name === "git") return gitKind(args) === undefined ? [] : ["push"];
  if (name === "gh") {
    if (ghKind(args) === undefined) return [];
    const positional: Array<string> = [];
    for (let i = 0; i < args.length && positional.length < 2; i++) {
      const arg = args[i]!;
      if (GH_VALUE_OPTIONS.has(arg)) i++;
      else if (!arg.startsWith("-")) positional.push(arg);
    }
    const action = GH_ACTIONS[positional.join(" ")];
    return action === undefined ? [] : [action];
  }
  if (name === "eval") return outwardActions(args.join(" "));
  if (SHELLS.has(name)) {
    const at = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
    const script = at === -1 ? undefined : args[at + 1];
    return script === undefined ? [] : outwardActions(script);
  }
  return [];
};

/**
 * Each outward thing a shell command line does by an ordinary spelling, once each, in the order
 * the line does them; empty when `outwardKind` finds nothing. A line too strange to read is
 * `undefined`: outward, by `outwardKind`'s leaning, but nobody can say what.
 */
export const outwardActions = (command: string): ReadonlyArray<OutwardAction> | undefined => {
  const commands: Array<ReadonlyArray<string>> = [];
  try {
    collectCommands(command, commands);
    const found = commands.flatMap((each) => {
      const actions = actionsOf(each);
      if (actions === undefined) throw new Error("unreadable");
      return actions;
    });
    return [...new Set(found)];
  } catch {
    return undefined;
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
