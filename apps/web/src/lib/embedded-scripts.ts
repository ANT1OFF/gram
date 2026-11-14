import { languageFor } from "@gram/contracts";

/**
 * Programs inside a shell command, found so each can be coloured in its own language: the Python
 * of `python3 - <<'PY'`, the shell inside `zsh -lc "…"` or an `ssh host '…'`, the SQL of
 * `psql -c`, a file written with `cat > x.ts <<EOF`.
 *
 * Each script's text is what the program receives, after the shell removes quotes and escapes, and
 * `starts[i]`/`ends[i]` is the stretch of the original command that spells its character `i` (two
 * characters for `\"`). Reading is best effort: a spelling that can't be mapped character for
 * character is left to the outer command's colours, never guessed.
 */
export interface EmbeddedScript {
  readonly language: string;
  readonly text: string;
  readonly starts: readonly number[];
  readonly ends: readonly number[];
}

/** Nesting this deep (`ssh` → `zsh -c` → `bash -c` → …) is as far as scripts are looked for. */
const MAX_DEPTH = 4;
/** Bounds the work for one command; the outer colours stay either way. */
const MAX_SCRIPTS = 32;

interface Mapped {
  text: string;
  starts: number[];
  ends: number[];
}

interface Word extends Mapped {
  /** The value as typed, for flag matching; `undefined` when it can't be mapped exactly. */
  exact: boolean;
}

interface HereDoc {
  fd: number;
  delimiter: string;
  strip: boolean;
  body?: Mapped;
}

interface SimpleCommand {
  words: Word[];
  /** `<<<` and `>`-style redirections, in order. */
  hereStrings: { fd: number; word: Word }[];
  outputs: string[];
  hereDocs: HereDoc[];
}

interface Lexed {
  commands: SimpleCommand[];
  /** `$(…)`, `` `…` `` and `<(…)` bodies, as stretches of the text, read again as shell. */
  substitutions: { start: number; end: number }[];
}

const identity = (text: string): Mapped => {
  const starts = Array.from({ length: text.length }, (_, index) => index);
  return { text, starts, ends: starts.map((index) => index + 1) };
};

/** Every script inside `command`, outermost first, so inner ones are painted last. */
export function embeddedScripts(command: string): EmbeddedScript[] {
  const found: EmbeddedScript[] = [];
  try {
    collect(identity(command), 0, found);
  } catch {
    // A shape the reader didn't expect: the outer colours stand.
  }
  return found.slice(0, MAX_SCRIPTS);
}

function collect(source: Mapped, depth: number, found: EmbeddedScript[]) {
  if (found.length >= MAX_SCRIPTS) return;
  const lexed = lex(source.text);
  const scripts: { language: string; mapped: Mapped }[] = [];
  for (const command of lexed.commands) scripts.push(...scriptsOf(command));
  for (const { language, mapped } of scripts) {
    if (mapped.text.trim() === "") continue;
    const script: EmbeddedScript = {
      language,
      text: mapped.text,
      starts: mapped.starts.map((start) => source.starts[start]!),
      ends: mapped.ends.map((end) => source.ends[end - 1]!),
    };
    found.push(script);
    if (language === "shellscript" && depth + 1 < MAX_DEPTH) {
      collect(
        { text: script.text, starts: [...script.starts], ends: [...script.ends] },
        depth + 1,
        found,
      );
    }
  }
  if (depth + 1 >= MAX_DEPTH) return;
  for (const { start, end } of lexed.substitutions) {
    collect(
      {
        text: source.text.slice(start, end),
        starts: source.starts.slice(start, end),
        ends: source.ends.slice(start, end),
      },
      depth + 1,
      found,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Reading the shell

const BLANK = new Set([" ", "\t"]);
const ENDS_WORD = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">"]);

/** A small POSIX/bash reader: words with their spelling, separators, redirections, here-docs. */
function lex(text: string): Lexed {
  const commands: SimpleCommand[] = [];
  const substitutions: Lexed["substitutions"] = [];
  let current = newCommand();
  /** Here-docs whose bodies start on the next line. */
  let waiting: HereDoc[] = [];
  let index = 0;

  const finish = () => {
    if (current.words.length > 0 || current.hereDocs.length > 0 || current.hereStrings.length > 0)
      commands.push(current);
    current = newCommand();
  };

  while (index < text.length) {
    const char = text[index]!;
    if (BLANK.has(char)) {
      index += 1;
      continue;
    }
    if (char === "\\" && text[index + 1] === "\n") {
      index += 2;
      continue;
    }
    if (char === "#") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "\n") {
      finish();
      index += 1;
      for (const hereDoc of waiting) index = readHereDocBody(text, index, hereDoc);
      waiting = [];
      continue;
    }
    if (char === ";" || char === "&" || char === "|" || char === "(" || char === ")") {
      if (char === "&" && text[index + 1] === ">") {
        // `&>file` and `&>>file`: both streams to a file.
        index += text[index + 2] === ">" ? 3 : 2;
        const target = readWord(text, index, substitutions);
        index = target.next;
        current.outputs.push(target.word.text);
        continue;
      }
      finish();
      index += 1;
      if ((char === "&" || char === "|" || char === ";") && text[index] === char) index += 1;
      else if (char === "|" && text[index] === "&") index += 1;
      continue;
    }
    // A redirection, with an optional descriptor spelled right before it; `<(…)` is a word.
    const substituted = (char === "<" || char === ">") && text[index + 1] === "(";
    const redirect = /^(\d*)(<<<|<<-|<<|<>|<&|>&|>>|>\||<|>)/u.exec(text.slice(index, index + 8));
    if (!substituted && redirect && (redirect[1] === "" || startsWord(text, index))) {
      const [whole, digits = "", operator = ""] = redirect;
      const fd = digits === "" ? (operator.startsWith("<") ? 0 : 1) : Number(digits);
      index += whole.length;
      while (BLANK.has(text[index] ?? "")) index += 1;
      const target = readWord(text, index, substitutions);
      index = target.next;
      if (operator === "<<" || operator === "<<-") {
        const hereDoc: HereDoc = { fd, delimiter: target.raw, strip: operator === "<<-" };
        current.hereDocs.push(hereDoc);
        waiting.push(hereDoc);
      } else if (operator === "<<<") {
        current.hereStrings.push({ fd, word: target.word });
      } else if (operator.startsWith(">") && fd === 1) {
        current.outputs.push(target.word.text);
      }
      continue;
    }
    const read = readWord(text, index, substitutions);
    if (read.next === index) {
      // Nothing a word can start with: step over it rather than stall.
      index += 1;
      continue;
    }
    index = read.next;
    current.words.push(read.word);
  }
  finish();
  return { commands, substitutions };
}

const newCommand = (): SimpleCommand => ({ words: [], hereStrings: [], outputs: [], hereDocs: [] });

const startsWord = (text: string, index: number) => index === 0 || ENDS_WORD.has(text[index - 1]!);

/** A here-doc's body, from `start` to the line that ends it; the index after that line. */
function readHereDocBody(text: string, start: number, hereDoc: HereDoc): number {
  let line = start;
  while (line <= text.length) {
    const lineEnd = text.indexOf("\n", line);
    const end = lineEnd === -1 ? text.length : lineEnd;
    const content = text.slice(line, end).replace(/\r$/u, "");
    if ((hereDoc.strip ? content.replace(/^\t+/u, "") : content) === hereDoc.delimiter) {
      // The body's own last newline belongs to it; the terminator line does not.
      hereDoc.body = slice(text, start, line);
      return lineEnd === -1 ? text.length : lineEnd + 1;
    }
    if (lineEnd === -1) break;
    line = lineEnd + 1;
  }
  // No terminator: the rest of the text is the body, as a shell would read it with a warning.
  hereDoc.body = slice(text, start, text.length);
  return text.length;
}

const slice = (text: string, start: number, end: number): Mapped => {
  const starts = Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index);
  return { text: text.slice(start, end), starts, ends: starts.map((at) => at + 1) };
};

/**
 * One word from `start`: its value with each character's spelling, the delimiter-style raw value
 * (quotes removed, nothing expanded) and where it stops.
 */
function readWord(
  text: string,
  start: number,
  substitutions: Lexed["substitutions"],
): { word: Word; raw: string; next: number } {
  const word: Word = { text: "", starts: [], ends: [], exact: true };
  let raw = "";
  const push = (character: string, at: number, length: number) => {
    word.text += character;
    word.starts.push(at);
    word.ends.push(at + length);
  };
  const pushRaw = (from: number, to: number) => {
    for (let at = from; at < to; at += 1) push(text[at]!, at, 1);
  };
  let index = start;
  while (index < text.length) {
    const char = text[index]!;
    if (ENDS_WORD.has(char)) {
      // `<(…)` and `>(…)` start a word of their own.
      if ((char === "<" || char === ">") && text[index + 1] === "(" && index === start) {
        const end = balanced(text, index + 2, "(", ")");
        substitutions.push({ start: index + 2, end: Math.max(index + 2, end - 1) });
        pushRaw(index, end);
        raw += text.slice(index, end);
        index = end;
        continue;
      }
      break;
    }
    if (char === "\\") {
      const next = text[index + 1];
      if (next === undefined) {
        push(char, index, 1);
        index += 1;
      } else if (next === "\n") {
        index += 2;
      } else {
        push(next, index, 2);
        raw += next;
        index += 2;
      }
      continue;
    }
    if (char === "'") {
      const close = text.indexOf("'", index + 1);
      const end = close === -1 ? text.length : close;
      pushRaw(index + 1, end);
      raw += text.slice(index + 1, end);
      index = close === -1 ? text.length : close + 1;
      continue;
    }
    if (char === "$" && text[index + 1] === "'") {
      // ANSI-C quoting: `\n` and friends don't map character for character.
      let at = index + 2;
      while (at < text.length && text[at] !== "'") at += text[at] === "\\" ? 2 : 1;
      const body = text.slice(index + 2, Math.min(at, text.length));
      if (body.includes("\\")) word.exact = false;
      pushRaw(index + 2, Math.min(at, text.length));
      raw += body;
      index = Math.min(at + 1, text.length);
      continue;
    }
    if (char === '"') {
      let at = index + 1;
      while (at < text.length && text[at] !== '"') {
        const inner = text[at]!;
        if (inner === "\\" && at + 1 < text.length && '$`"\\\n'.includes(text[at + 1]!)) {
          if (text[at + 1] !== "\n") {
            push(text[at + 1]!, at, 2);
            raw += text[at + 1];
          }
          at += 2;
        } else if (inner === "$" && text[at + 1] === "(") {
          const end = balanced(text, at + 2, "(", ")");
          if (text[at + 2] !== "(")
            substitutions.push({ start: at + 2, end: Math.max(at + 2, end - 1) });
          pushRaw(at, end);
          raw += text.slice(at, end);
          at = end;
        } else if (inner === "$" && text[at + 1] === "{") {
          const end = balanced(text, at + 2, "{", "}");
          pushRaw(at, end);
          raw += text.slice(at, end);
          at = end;
        } else if (inner === "`") {
          const end = backtick(text, at + 1);
          substitutions.push({ start: at + 1, end: Math.max(at + 1, end - 1) });
          pushRaw(at, end);
          raw += text.slice(at, end);
          at = end;
        } else {
          push(inner, at, 1);
          raw += inner;
          at += 1;
        }
      }
      index = Math.min(at + 1, text.length);
      continue;
    }
    if (char === "$" && (text[index + 1] === "(" || text[index + 1] === "{")) {
      const open = text[index + 1]!;
      const end = balanced(text, index + 2, open, open === "(" ? ")" : "}");
      if (open === "(" && text[index + 2] !== "(")
        substitutions.push({ start: index + 2, end: Math.max(index + 2, end - 1) });
      pushRaw(index, end);
      raw += text.slice(index, end);
      index = end;
      continue;
    }
    if (char === "`") {
      const end = backtick(text, index + 1);
      substitutions.push({ start: index + 1, end: Math.max(index + 1, end - 1) });
      pushRaw(index, end);
      raw += text.slice(index, end);
      index = end;
      continue;
    }
    push(char, index, 1);
    raw += char;
    index += 1;
  }
  return { word, raw, next: index };
}

/** The index after the `close` that matches an already-open `open`, skipping quoted text. */
function balanced(text: string, start: number, open: string, close: string): number {
  let depth = 1;
  let index = start;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "'" && open === "(") {
      const end = text.indexOf("'", index + 1);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (char === '"') {
      let at = index + 1;
      while (at < text.length && text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
      index = at + 1;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return text.length;
}

function backtick(text: string, start: number): number {
  let index = start;
  while (index < text.length && text[index] !== "`") index += text[index] === "\\" ? 2 : 1;
  return Math.min(index + 1, text.length);
}

// ---------------------------------------------------------------------------------------------
// What each program runs

interface Interpreter {
  readonly language: string;
  /** Flags whose next word (or `=value`) is the program's code. */
  readonly inline: (flag: string) => boolean;
  /** Flags that take the next word as a value. */
  readonly values?: ReadonlySet<string>;
  /** Flags that run a file or module instead: the code isn't on the command line. */
  readonly fromFile?: ReadonlySet<string>;
  /** Reads its program from standard input: when no file is named, or always (SQL shells). */
  readonly stdin: "no-file" | "always" | "never";
  /** The code is this positional argument (0-based), as for `awk` and `sqlite3 db 'sql'`. */
  readonly positional?: number;
  /** Takes several `-c`/`-e` scripts, in order. */
  readonly repeatable?: boolean;
  /** Flag names match without case, as PowerShell's do. */
  readonly anyCase?: boolean;
}

const flags =
  (...names: string[]) =>
  (flag: string) =>
    names.includes(flag);

const SHELL: Interpreter = {
  language: "shellscript",
  // `-c`, and `-c` among others in one word: `-lc`, `-euc`.
  inline: (flag) => /^-[A-Za-z]*c[A-Za-z]*$/u.test(flag),
  values: new Set(["-o", "-O", "--rcfile", "--init-file"]),
  stdin: "no-file",
};

const SQL: Omit<Interpreter, "inline"> = {
  language: "sql",
  values: new Set([
    "-d",
    "-h",
    "-p",
    "-u",
    "-U",
    "-P",
    "--dbname",
    "--host",
    "--port",
    "--user",
    "--username",
  ]),
  stdin: "always",
  repeatable: true,
};

const INTERPRETERS: Readonly<Record<string, Interpreter>> = {
  sh: SHELL,
  bash: SHELL,
  zsh: SHELL,
  dash: SHELL,
  ksh: SHELL,
  ash: SHELL,
  fish: { language: "fish", inline: flags("-c", "--command"), stdin: "no-file" },
  python: {
    language: "python",
    inline: flags("-c"),
    values: new Set(["-W", "-X"]),
    fromFile: new Set(["-m"]),
    stdin: "no-file",
  },
  node: {
    language: "javascript",
    inline: flags("-e", "--eval", "-p", "--print"),
    values: new Set(["-r", "--require", "--import", "--loader", "-C", "--conditions"]),
    stdin: "no-file",
  },
  bun: { language: "typescript", inline: flags("-e", "--eval", "-p", "--print"), stdin: "never" },
  ruby: {
    language: "ruby",
    inline: flags("-e"),
    values: new Set(["-r", "-I", "-C"]),
    stdin: "no-file",
  },
  perl: {
    language: "perl",
    inline: flags("-e", "-E"),
    values: new Set(["-I", "-M"]),
    stdin: "no-file",
  },
  php: { language: "php", inline: flags("-r"), stdin: "never" },
  lua: { language: "lua", inline: flags("-e"), stdin: "no-file" },
  osascript: {
    language: "applescript",
    inline: flags("-e"),
    values: new Set(["-l", "-s"]),
    stdin: "no-file",
  },
  pwsh: {
    language: "powershell",
    inline: flags("-c", "-command"),
    values: new Set(["-executionpolicy", "-workingdirectory", "-windowstyle"]),
    fromFile: new Set(["-f", "-file", "-encodedcommand"]),
    stdin: "never",
    anyCase: true,
  },
  psql: { ...SQL, inline: flags("-c", "--command"), fromFile: new Set(["-f", "--file"]) },
  mysql: { ...SQL, inline: flags("-e", "--execute") },
  sqlite3: { ...SQL, inline: flags("-cmd"), positional: 1 },
  duckdb: { ...SQL, inline: flags("-c", "-cmd"), fromFile: new Set(["-f"]), positional: 1 },
  awk: {
    language: "awk",
    inline: () => false,
    values: new Set(["-F", "-v"]),
    fromFile: new Set(["-f"]),
    stdin: "never",
    positional: 0,
  },
};

const ALIASES: Readonly<Record<string, string>> = {
  powershell: "pwsh",
  mariadb: "mysql",
  gawk: "awk",
  mawk: "awk",
  nawk: "awk",
  pypy: "python",
  pypy3: "python",
};

/** Programs that run the command after their own options: `sudo -u x python3 -c …`. */
const WRAPPERS: Readonly<Record<string, ReadonlySet<string>>> = {
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S"]),
  sudo: new Set(["-u", "--user", "-g", "--group", "-C", "-D", "--chdir", "-h", "--host"]),
  doas: new Set(["-u"]),
  nice: new Set(["-n", "--adjustment"]),
  nohup: new Set(),
  exec: new Set(["-a"]),
  command: new Set(),
  builtin: new Set(),
  time: new Set(["-f", "-o"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
};

/** `ssh` options that take a value; the first word after them is the host. */
const SSH_VALUES = new Set([
  "-B",
  "-b",
  "-c",
  "-D",
  "-E",
  "-e",
  "-F",
  "-I",
  "-i",
  "-J",
  "-L",
  "-l",
  "-m",
  "-O",
  "-o",
  "-P",
  "-p",
  "-Q",
  "-R",
  "-S",
  "-W",
  "-w",
]);

/** Here-doc delimiters that say what they hold: `<<'PY'`, `<<SQL`. */
const DELIMITERS: Readonly<Record<string, string>> = {
  py: "python",
  python: "python",
  js: "javascript",
  javascript: "javascript",
  node: "javascript",
  ts: "typescript",
  typescript: "typescript",
  sql: "sql",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "shellscript",
  bash: "shellscript",
  shell: "shellscript",
  zsh: "shellscript",
  rb: "ruby",
  ruby: "ruby",
  html: "html",
  css: "css",
  md: "markdown",
  markdown: "markdown",
  xml: "xml",
  diff: "diff",
  patch: "diff",
};

const basename = (word: string) =>
  (word.split(/[\\/]/u).at(-1) ?? "").toLowerCase().replace(/\.exe$/u, "");

function interpreterFor(name: string): Interpreter | undefined {
  if (/^python\d*(?:\.\d+)?$/u.test(name)) return INTERPRETERS["python"];
  const key = ALIASES[name] ?? name;
  return Object.hasOwn(INTERPRETERS, key) ? INTERPRETERS[key] : undefined;
}

/** Where the program itself is: past `FOO=1` assignments and wrappers such as `env` and `sudo`. */
function programAt(words: readonly Word[]): number {
  let index = 0;
  while (index < words.length && /^[A-Za-z_]\w*=/u.test(words[index]!.text)) index += 1;
  while (index < words.length) {
    const name = basename(words[index]!.text);
    const values = WRAPPERS[name];
    if (!Object.hasOwn(WRAPPERS, name) || !values) {
      if (name === "timeout") {
        // `timeout [options] duration command`.
        index += 1;
        while (index < words.length && words[index]!.text.startsWith("-")) index += 1;
        index += 1;
        continue;
      }
      return index;
    }
    index += 1;
    while (index < words.length) {
      const value = words[index]!.text;
      if (value.startsWith("-")) index += values.has(value) ? 2 : 1;
      else if (/^[A-Za-z_]\w*=/u.test(value)) index += 1;
      else break;
    }
  }
  return index;
}

interface Found {
  language: string;
  mapped: Mapped;
}

function scriptsOf(command: SimpleCommand): Found[] {
  const at = programAt(command.words);
  const program = command.words[at];
  const scripts: Found[] = [];
  let stdinLanguage: string | undefined;
  if (program) {
    const name = basename(program.text);
    const args = command.words.slice(at + 1);
    if (name === "ssh") {
      const remote = sshCommand(args);
      if (remote) {
        scripts.push({ language: "shellscript", mapped: remote });
        // What the remote command reads from its input, as `ssh host 'python3 -' <<'PY'`.
        stdinLanguage = stdinLanguageOf(remote.text);
      }
    } else if ((name === "kubectl" || name === "oc") && args[0]?.text === "exec") {
      const dash = args.findIndex((word) => word.text === "--");
      if (dash !== -1) {
        const inner = scriptsOf({ ...command, words: args.slice(dash + 1) });
        return inner;
      }
    } else {
      const interpreter = interpreterFor(name);
      if (interpreter) {
        const read = interpreterScripts(interpreter, args);
        for (const script of read.scripts)
          scripts.push({ language: interpreter.language, mapped: script });
        if (
          interpreter.stdin === "always" ||
          (interpreter.stdin === "no-file" && !read.named && read.scripts.length === 0)
        )
          stdinLanguage = interpreter.language;
      }
      if (name === "git" && args[0]?.text === "apply") stdinLanguage = "diff";
      if (name === "patch") stdinLanguage = "diff";
    }
    for (const { fd, word } of command.hereStrings) {
      if (fd === 0 && stdinLanguage && word.exact)
        scripts.push({ language: stdinLanguage, mapped: word });
    }
    const written =
      name === "cat"
        ? command.outputs.at(-1)
        : name === "tee"
          ? args.find((word) => !word.text.startsWith("-"))?.text
          : undefined;
    const writtenLanguage = written === undefined ? undefined : languageFor(written);
    for (const hereDoc of command.hereDocs) {
      if (!hereDoc.body) continue;
      const language =
        (hereDoc.fd === 0 ? (stdinLanguage ?? writtenLanguage) : undefined) ??
        DELIMITERS[hereDoc.delimiter.toLowerCase()];
      if (language) scripts.push({ language, mapped: hereDoc.body });
    }
  } else {
    for (const hereDoc of command.hereDocs) {
      const language = DELIMITERS[hereDoc.delimiter.toLowerCase()];
      if (hereDoc.body && language) scripts.push({ language, mapped: hereDoc.body });
    }
  }
  return scripts;
}

/** The code an interpreter's arguments carry, and whether they name a file to run instead. */
function interpreterScripts(
  interpreter: Interpreter,
  args: readonly Word[],
): { scripts: Mapped[]; named: boolean } {
  const scripts: Mapped[] = [];
  const positionals: Word[] = [];
  let named = false;
  let ended = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const flag = interpreter.anyCase ? arg.text.toLowerCase() : arg.text;
    if (!ended && flag === "--") {
      ended = true;
      continue;
    }
    if (!ended && flag.startsWith("-") && flag !== "-") {
      const equals = flag.startsWith("--") ? flag.indexOf("=") : -1;
      const name = equals === -1 ? flag : flag.slice(0, equals);
      if (interpreter.fromFile?.has(name)) {
        named = true;
        if (!interpreter.repeatable) return { scripts, named };
        if (equals === -1) index += 1;
        continue;
      }
      if (interpreter.inline(name)) {
        if (equals !== -1) {
          if (arg.exact) scripts.push(sliceMapped(arg, equals + 1));
        } else {
          const next = args[index + 1];
          if (next?.exact) scripts.push(next);
          index += 1;
        }
        if (!interpreter.repeatable) return { scripts, named: true };
        continue;
      }
      if (equals === -1 && interpreter.values?.has(flag)) index += 1;
      continue;
    }
    positionals.push(arg);
    if (interpreter.positional === undefined && interpreter.stdin !== "always") break;
  }
  if (interpreter.positional !== undefined && !named) {
    for (const word of positionals.slice(interpreter.positional)) {
      if (word.exact) scripts.push(word);
      if (!interpreter.repeatable) break;
    }
    return { scripts, named: scripts.length > 0 };
  }
  if (interpreter.stdin === "always") return { scripts, named };
  const first = positionals[0];
  return { scripts, named: named || (first !== undefined && first.text !== "-") };
}

const sliceMapped = (mapped: Mapped, start: number): Mapped => ({
  text: mapped.text.slice(start),
  starts: mapped.starts.slice(start),
  ends: mapped.ends.slice(start),
});

/** `ssh [options] host command`: the remote command, when it is one word. */
function sshCommand(args: readonly Word[]): Mapped | undefined {
  let index = 0;
  while (index < args.length && args[index]!.text.startsWith("-")) {
    const flag = args[index]!.text;
    if (flag === "--") {
      index += 1;
      break;
    }
    index += SSH_VALUES.has(flag) ? 2 : 1;
  }
  const rest = args.slice(index + 1);
  return rest.length === 1 && rest[0]!.exact ? rest[0] : undefined;
}

/** The language the last command of `script` reads as its program from standard input. */
function stdinLanguageOf(script: string): string | undefined {
  const last = lex(script).commands.at(-1);
  if (!last) return undefined;
  const at = programAt(last.words);
  const program = last.words[at];
  if (!program) return undefined;
  const interpreter = interpreterFor(basename(program.text));
  if (!interpreter || interpreter.stdin === "never") return undefined;
  const read = interpreterScripts(interpreter, last.words.slice(at + 1));
  if (interpreter.stdin === "always") return interpreter.language;
  return read.named || read.scripts.length > 0 ? undefined : interpreter.language;
}
