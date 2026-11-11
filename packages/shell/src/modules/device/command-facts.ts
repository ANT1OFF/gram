import { posix } from "node:path";

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
  | { readonly kind: "redirect"; readonly target: string; readonly writes: boolean }
  | { readonly kind: "pipe-to-interpreter"; readonly program: string }
  | { readonly kind: "elevates"; readonly program: string }
  | { readonly kind: "network"; readonly program: string }
  | { readonly kind: "outside-folder"; readonly path: string }
  /** Text run as a command: `eval`, `sh -c`, `source`, `xargs`. */
  | { readonly kind: "evaluates"; readonly program: string }
  | { readonly kind: "background" }
  | { readonly kind: "here-document" };

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
]);

const GIT_NETWORK = new Set(["clone", "fetch", "pull", "push", "ls-remote", "submodule", "remote"]);
const INSTALLS = new Set(["install", "i", "add", "publish", "update", "upgrade", "ci", "get"]);

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
  ...ELEVATORS,
]);

/** A wrapper's options that take the next word as their value. */
const OPTIONS_WITH_VALUES: Readonly<Record<string, string>> = {
  sudo: "-u -g -C -D -h -p -r -t -T -U",
  doas: "-u -C",
  su: "-c -g -G -s",
  env: "-u -C -S",
  nice: "-n",
  timeout: "-s -k",
  ionice: "-c -n -p",
  stdbuf: "-i -o -e",
  xargs: "-I -n -P -L -s -d -E -a",
};

const EVALUATORS = new Set(["eval", "source", ".", "xargs"]);

/** Reserved words after which a command starts. */
const COMMAND_STARTERS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{"]);
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
}

type Token =
  | { readonly kind: "word"; readonly word: Word }
  | { readonly kind: "op"; readonly op: string };

interface Found {
  programs: Array<string>;
  facts: Array<CommandFact>;
  names: Set<string>;
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
  const heredocs: Array<{ delimiter: string }> = [];
  let at = 0;
  let word = "";
  let expands = false;
  let inWord = false;
  let inner: Array<string> = [];
  const flush = () => {
    if (inWord) tokens.push({ kind: "word", word: { text: word, expands, inner } });
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
    if (next === "(" && text[at + 2] === "(") {
      const end = closing(text, at + 1, "(", ")");
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
      const name = NAME.exec(text.slice(at + 2, end - 1))?.[0];
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
        const delimiter = text.slice(start, at).replaceAll(/['"\\]/g, "");
        if (delimiter === "") throw new Unreadable();
        heredocs.push({ delimiter });
        found.facts.push({ kind: "here-document" });
        tokens.push({ kind: "word", word: { text: delimiter, expands: false, inner: [] } });
      }
      if (op === "\n" && heredocs.length > 0) {
        // The documents' lines follow, each to its delimiter: data, not commands.
        for (const { delimiter } of heredocs.splice(0)) {
          for (;;) {
            if (at >= text.length) throw new Unreadable();
            const end = text.indexOf("\n", at);
            const line = text.slice(at, end < 0 ? text.length : end);
            at = end < 0 ? text.length : end + 1;
            if (line.replace(/^\t+/, "") === delimiter) break;
          }
        }
      }
      continue;
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

/** Notes a word that names a place outside the lent folder. */
const pathFacts = (word: Word, found: Found, place: CommandPlace) => {
  if (word.expands) return;
  const text = word.text.includes("=") ? word.text.slice(word.text.indexOf("=") + 1) : word.text;
  if (text.startsWith("~")) {
    found.facts.push({ kind: "outside-folder", path: text });
    return;
  }
  if (!text.startsWith("/") && !text.startsWith("..")) return;
  const resolved = posix.resolve(place.cwd, text);
  if (!inside(place.folder, resolved)) found.facts.push({ kind: "outside-folder", path: text });
};

const baseName = (program: string) => program.slice(program.lastIndexOf("/") + 1);

/** One simple command: its program, what wraps it, and its arguments. */
const simple = (words: ReadonlyArray<Word>, found: Found, place: CommandPlace, depth: number) => {
  let index = 0;
  // Assignments before the program set its environment.
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]?.text ?? ""))
    index += 1;
  while (index < words.length) {
    const word = words[index];
    if (word === undefined) return;
    if (word.expands) {
      found.facts.push({ kind: "program-expanded" });
      return;
    }
    const program = word.text;
    const name = baseName(program);
    if (!found.programs.includes(program)) found.programs.push(program);
    const args = words.slice(index + 1);
    for (const arg of args) pathFacts(arg, found, place);
    if (program.includes("/")) {
      const resolved = posix.resolve(place.cwd, program);
      if (inside(place.folder, resolved)) found.facts.push({ kind: "runs-folder-code", program });
      else found.facts.push({ kind: "outside-folder", path: program });
    }
    if (ELEVATORS.has(name)) found.facts.push({ kind: "elevates", program: name });
    if (NETWORK.has(name)) found.facts.push({ kind: "network", program: name });
    const sub = args.find((arg) => !arg.text.startsWith("-"))?.text;
    if (name === "git" && sub !== undefined && GIT_NETWORK.has(sub))
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
    if (INTERPRETERS.has(name)) {
      const flag = args.findIndex((arg) => /^-[a-zA-Z]*c$/.test(arg.text) || arg.text === "-e");
      if (flag >= 0) {
        found.facts.push({ kind: "evaluates", program: name });
        const script = args[flag + 1];
        if (script !== undefined && ["sh", "bash", "zsh", "dash", "ksh"].includes(name)) {
          if (script.expands) found.facts.push({ kind: "program-expanded" });
          else walk(script.text, found, place, depth + 1);
        }
      } else if (sub !== undefined)
        found.facts.push({ kind: "runs-folder-code", program: `${name} ${sub}` });
    }
    if (!WRAPPERS.has(name)) return;
    // The wrapped program comes after the wrapper's options, and for `env`, its assignments.
    index += 1;
    while (index < words.length) {
      const next = words[index]?.text ?? "";
      if (next === "--") {
        index += 1;
        break;
      }
      if (next.startsWith("-")) {
        index += (OPTIONS_WITH_VALUES[name] ?? "").split(" ").includes(next) ? 2 : 1;
        continue;
      }
      if (name === "env" && next.includes("=")) {
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
      simple(words, found, place, depth);
      for (const word of words) readInner(word);
      const program = baseName(words[0]?.text ?? "");
      if (afterPipe && INTERPRETERS.has(program))
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
          target: token.word.expands ? "a name decided when it runs" : token.word.text,
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
      if (token.word.text === "case") throw new Unreadable();
      if (token.word.text === "for" || token.word.text === "select") {
        skipping = "for";
        continue;
      }
      if (COMMAND_STARTERS.has(token.word.text) || ENDERS.has(token.word.text)) continue;
      if (token.word.text === "function") throw new Unreadable();
    }
    words.push(token.word);
  }
  if (redirect !== undefined) throw new Unreadable();
  end();
};

/** The facts about a command, for the ask. */
export const commandFacts = (command: string, place: CommandPlace): CommandFacts => {
  const found: Found = { programs: [], facts: [], names: new Set() };
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

/** How the ask words a fact. Plain text, drawn as text. */
export const commandFactText = (fact: CommandFact): string => {
  switch (fact.kind) {
    case "runs-folder-code":
      return `Runs code from this folder (${fact.program})`;
    case "substitution":
      return "Runs a command inside the command";
    case "expansion":
      return `Uses values set when it runs: ${fact.names.join(", ")}`;
    case "program-expanded":
      return "Runs a program whose name is only known when it runs";
    case "redirect":
      return fact.writes ? `Writes to ${fact.target}` : `Reads from ${fact.target}`;
    case "pipe-to-interpreter":
      return `Passes text to ${fact.program} to run`;
    case "elevates":
      return `Asks for more rights (${fact.program})`;
    case "network":
      return `Uses the network (${fact.program})`;
    case "outside-folder":
      return `Names a place outside the folder: ${fact.path}`;
    case "evaluates":
      return `Runs text as a command (${fact.program})`;
    case "background":
      return "Leaves something running in the background";
    case "here-document":
      return "Carries text written into the command";
  }
};
