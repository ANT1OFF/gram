// What a thread posted on GitHub, read back from its tool calls: the bodies its `gh pr comment`,
// `gh pr review`, `gh api … -f body=` and review-reply calls sent, and the GitHub links their
// output printed. A comment counts as the thread's own only when its whole text is one of those
// bodies, or its link was printed: never because a few of its words turn up in some command, which
// would drop the user's "Stop." or "rebase" as the thread's own.

import type { GramUIMessage } from "@gram/contracts";

/** What a thread posted, normalised by `sameText`. */
export interface Posted {
  readonly bodies: ReadonlySet<string>;
  readonly urls: ReadonlySet<string>;
}

/** Text as compared: trimmed, line endings and runs of whitespace made one space. */
export const sameText = (text: string): string => text.replaceAll(/\s+/g, " ").trim();

/** Longest command line parsed; a body longer than this isn't looked for in it. */
const MAX_COMMAND = 64_000;

interface ShellCommand {
  readonly words: ReadonlyArray<string>;
  /** What a heredoc on the command fed its standard input. */
  readonly stdin?: string | undefined;
}

const HEREDOC = /^<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/;

/**
 * A command line as the shell would split it: words with quotes and escapes resolved, commands
 * apart at `;`, `&&`, `||`, `|`, `&` and line ends, and each heredoc's text kept with its command.
 * `$(…)` stays as written, inside the word it is in. Not a shell: what it can't follow it keeps as
 * text, so a body built from a variable simply matches nothing.
 */
export const shellCommands = (line: string): Array<ShellCommand> => {
  const src = line.slice(0, MAX_COMMAND);
  const commands: Array<ShellCommand> = [];
  let words: Array<string> = [];
  let stdin: string | undefined;
  let word = "";
  let inWord = false;
  const heredocs: Array<{ readonly tag: string; readonly strip: boolean }> = [];
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push({ words, ...(stdin === undefined ? {} : { stdin }) });
    words = [];
    stdin = undefined;
  };
  /**
   * The end of a balanced `$(…)` opening at `from`, or the end of the text. A heredoc inside it is
   * skipped whole, so a parenthesis in a comment's text doesn't end it early.
   */
  const closeParen = (from: number) => {
    let depth = 0;
    const pending: Array<string> = [];
    for (let j = from; j < src.length; j++) {
      const c = src[j];
      if (c === "\\") j++;
      else if (c === "<" && src[j + 1] === "<") {
        const match = HEREDOC.exec(src.slice(j));
        if (match !== null) {
          pending.push(match[3]!);
          j += match[0].length - 1;
        }
      } else if (c === "\n" && pending.length > 0) {
        for (const tag of pending) {
          let at = j + 1;
          for (;;) {
            const end = src.indexOf("\n", at);
            const raw = src.slice(at, end === -1 ? src.length : end).replace(/^\t+/, "");
            if (end === -1) return src.length;
            at = end + 1;
            if (raw.trim() === tag) break;
          }
          j = at - 2;
        }
        pending.length = 0;
      } else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return j + 1;
    }
    return src.length;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\n") {
      // Heredocs start on the line after the one that named them.
      let at = i + 1;
      for (const { tag, strip } of heredocs) {
        const lines: Array<string> = [];
        while (at <= src.length) {
          const end = src.indexOf("\n", at);
          const raw = src.slice(at, end === -1 ? src.length : end);
          at = end === -1 ? src.length + 1 : end + 1;
          if ((strip ? raw.replace(/^\t+/, "") : raw) === tag) break;
          lines.push(strip ? raw.replace(/^\t+/, "") : raw);
        }
        stdin = lines.join("\n");
      }
      heredocs.length = 0;
      endCommand();
      i = at;
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      i++;
      continue;
    }
    if (c === "#" && !inWord) {
      const end = src.indexOf("\n", i);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (c === ";" || c === "|" || c === "&") {
      endCommand();
      i += src[i + 1] === c ? 2 : 1;
      continue;
    }
    if (c === "<" && src[i + 1] === "<") {
      const match = HEREDOC.exec(src.slice(i));
      if (match !== null) {
        endWord();
        heredocs.push({ tag: match[3]!, strip: match[1] === "-" });
        i += match[0].length;
        continue;
      }
    }
    inWord = true;
    if (c === "\\") {
      if (src[i + 1] === "\n") i += 2;
      else {
        word += src[i + 1] ?? "";
        i += 2;
      }
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      word += src.slice(i + 1, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end + 1;
    } else if (c === "$" && src[i + 1] === "'") {
      let j = i + 2;
      while (j < src.length && src[j] !== "'") {
        if (src[j] === "\\") {
          const e = src[j + 1];
          word += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : (e ?? "");
          j += 2;
        } else word += src[j++];
      }
      i = j + 1;
    } else if (c === "$" && src[i + 1] === "(") {
      const end = closeParen(i + 1);
      word += src.slice(i, end);
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && '"\\$`\n'.includes(src[j + 1] ?? "")) {
          if (src[j + 1] !== "\n") word += src[j + 1];
          j += 2;
        } else if (src[j] === "$" && src[j + 1] === "(") {
          const end = closeParen(j + 1);
          word += src.slice(j, end);
          j = end;
        } else word += src[j++];
      }
      i = j + 1;
    } else {
      word += c;
      i++;
    }
  }
  endCommand();
  return commands;
};

/** `$(cat <<'EOF' … EOF)`, the way agents pass a long body inline, as the text it stands for. */
const CAT_HEREDOC =
  /^\$\(\s*cat\s*<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1[ \t]*\n([\s\S]*?)\n[ \t]*\2[ \t]*\n?\s*\)$/;

const unwrap = (value: string): string => CAT_HEREDOC.exec(value)?.[3] ?? value;

const SHELLS = new Set(["bash", "sh", "zsh", "/bin/bash", "/bin/sh", "/bin/zsh"]);

/** The bodies one shell command posts: gh's comment and review flags, and `gh api`'s body field. */
const bodiesOf = (
  command: ShellCommand,
  files: ReadonlyMap<string, string>,
): ReadonlyArray<string> => {
  const { words } = command;
  // `bash -lc '…'`, as Codex runs a command line.
  if (words.length >= 3 && SHELLS.has(words[0]!) && /^-\w*c$/.test(words[1]!)) {
    return shellCommands(words[2]!).flatMap((inner) => bodiesOf(inner, files));
  }
  const gh = words.indexOf("gh");
  if (gh === -1) return [];
  const args = words.slice(gh + 1);
  const sub = args.slice(0, 2).join(" ");
  const fromFile = (path: string) => {
    if (path === "-") return command.stdin;
    return files.get(path) ?? [...files].find(([written]) => written.endsWith(`/${path}`))?.[1];
  };
  const out: Array<string> = [];
  if (sub === "pr comment" || sub === "pr review" || sub === "issue comment") {
    for (let k = 2; k < args.length; k++) {
      const arg = args[k]!;
      const value = args[k + 1];
      if ((arg === "--body" || arg === "-b") && value !== undefined) out.push(unwrap(value));
      else if (arg.startsWith("--body=")) out.push(unwrap(arg.slice("--body=".length)));
      else if ((arg === "--body-file" || arg === "-F") && value !== undefined) {
        const text = fromFile(value);
        if (text !== undefined) out.push(text);
      }
    }
  } else if (args[0] === "api") {
    for (let k = 1; k < args.length; k++) {
      const arg = args[k]!;
      const value = args[k + 1];
      const field =
        (arg === "-f" || arg === "-F" || arg === "--field" || arg === "--raw-field") &&
        value !== undefined
          ? value
          : arg.startsWith("--field=") || arg.startsWith("--raw-field=")
            ? arg.slice(arg.indexOf("=") + 1)
            : undefined;
      if (field === undefined || !field.startsWith("body=")) continue;
      const text = field.slice("body=".length);
      if (text.startsWith("@")) {
        const file = fromFile(text.slice(1));
        if (file !== undefined) out.push(file);
      } else out.push(unwrap(text));
    }
  }
  return out;
};

const strings = (value: unknown, out: Array<string>, depth = 0): void => {
  if (depth > 4) return;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const each of value) strings(each, out, depth + 1);
  else if (typeof value === "object" && value !== null)
    for (const each of Object.values(value)) strings(each, out, depth + 1);
};

const GITHUB_LINK = /https:\/\/github\.com\/[^\s"'<>()\]]+/g;

interface ToolCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly output: unknown;
}

const toolCalls = (messages: ReadonlyArray<GramUIMessage>): Array<ToolCall> =>
  messages.flatMap((message) =>
    message.role !== "assistant"
      ? []
      : message.parts.flatMap((part): Array<ToolCall> => {
          if (part.type !== "dynamic-tool" && !part.type.startsWith("tool-")) return [];
          const raw = part as {
            readonly toolName?: unknown;
            readonly input?: unknown;
            readonly output?: unknown;
          };
          const name =
            typeof raw.toolName === "string" ? raw.toolName : part.type.slice("tool-".length);
          const input =
            typeof raw.input === "object" && raw.input !== null && !Array.isArray(raw.input)
              ? (raw.input as Record<string, unknown>)
              : {};
          return [{ name, input, output: raw.output }];
        }),
  );

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** What `messages` posted to GitHub: every body their tool calls sent, and every link printed back. */
export const postedIn = (messages: ReadonlyArray<GramUIMessage>): Posted => {
  const calls = toolCalls(messages);
  const files = new Map<string, string>();
  for (const call of calls) {
    const path = str(call.input["file_path"]) ?? str(call.input["path"]);
    const content = str(call.input["content"]);
    if (path !== undefined && content !== undefined) files.set(path, content);
  }
  const bodies = new Set<string>();
  const urls = new Set<string>();
  for (const call of calls) {
    // Gram's own review-reply tool, under any agent's name for it.
    if (call.name.endsWith("pr_reply_to_thread")) {
      const body = str(call.input["body"]);
      if (body !== undefined) bodies.add(sameText(body));
    }
    const command = call.input["command"] ?? call.input["cmd"];
    const parsed: ReadonlyArray<ShellCommand> = Array.isArray(command)
      ? [{ words: command.filter((w): w is string => typeof w === "string") }]
      : typeof command === "string"
        ? shellCommands(command)
        : [];
    for (const each of parsed) for (const body of bodiesOf(each, files)) bodies.add(sameText(body));
    const printed: Array<string> = [];
    strings(call.output, printed);
    for (const text of printed) for (const link of text.match(GITHUB_LINK) ?? []) urls.add(link);
  }
  bodies.delete("");
  return { bodies, urls };
};
