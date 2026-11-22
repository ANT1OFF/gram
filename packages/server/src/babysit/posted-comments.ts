import type { GramUIMessage } from "@gram/contracts";

/** Text as compared: trimmed, line endings and runs of whitespace made one space. */
export const sameText = (text: string): string => text.replaceAll(/\s+/g, " ").trim();

const MAX_COMMAND = 64_000;

interface ShellCommand {
  readonly words: ReadonlyArray<string>;
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

const CAT_HEREDOC =
  /^\$\(\s*cat\s*<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1[ \t]*\n([\s\S]*?)\n[ \t]*\2[ \t]*\n?\s*\)$/;

const unwrap = (value: string): string => CAT_HEREDOC.exec(value)?.[3] ?? value;

const SHELLS = new Set(["bash", "sh", "zsh", "/bin/bash", "/bin/sh", "/bin/zsh"]);

/** The PR a post went to, as its command named it. */
export interface PostTarget {
  /** `owner/repo`; absent when the command named none (the checkout's). */
  readonly repo?: string | undefined;
  readonly number: number;
}

interface Sent {
  readonly body: string;
  readonly pr?: PostTarget | undefined;
}

interface Posting {
  readonly sent: ReadonlyArray<Sent>;
  readonly posts: number;
  readonly reads: boolean;
}

const READ: Posting = { sent: [], posts: 0, reads: true };

const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)(?:[/#?].*)?$/;
const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;
const API_PATH =
  /^\/?repos\/([^/]+\/[^/]+)\/(?:issues|pulls)\/(\d+)\/(?:comments|reviews)(?:[/?].*)?$/;
const API_POSTS = /^\/?repos\/[^/]+\/[^/]+\/(?:issues|pulls)\/(?:\d+\/)?(?:comments|reviews)\b/;

const VALUED = new Set(["--body", "-b", "--body-file", "-F", "--repo", "-R"]);

const targetOf = (args: ReadonlyArray<string>): PostTarget | undefined => {
  let repo: string | undefined;
  let named: string | undefined;
  for (let k = 0; k < args.length; k++) {
    const arg = args[k]!;
    if (arg === "--repo" || arg === "-R") repo = args[k + 1];
    else if (arg.startsWith("--repo=")) repo = arg.slice("--repo=".length);
    if (VALUED.has(arg)) {
      k++;
      continue;
    }
    if (!arg.startsWith("-") && named === undefined) named = arg;
  }
  if (named === undefined) return undefined;
  const url = PR_URL.exec(named);
  if (url !== null) return { repo: url[1], number: Number(url[2]) };
  const number = /^#?(\d+)$/.exec(named)?.[1];
  if (number === undefined) return undefined;
  return {
    repo: repo !== undefined && OWNER_REPO.test(repo) ? repo : undefined,
    number: Number(number),
  };
};

const postingOf = (command: ShellCommand, files: ReadonlyMap<string, string>): Posting => {
  const { words } = command;
  if (words.length >= 3 && SHELLS.has(words[0]!) && /^-\w*c$/.test(words[1]!)) {
    const inner = shellCommands(words[2]!).map((each) => postingOf(each, files));
    return {
      sent: inner.flatMap((each) => each.sent),
      posts: inner.reduce((n, each) => n + each.posts, 0),
      reads: inner.some((each) => each.reads),
    };
  }
  const gh = words.indexOf("gh");
  if (gh === -1) return READ;
  const args = words.slice(gh + 1);
  const sub = args.slice(0, 2).join(" ");
  const fromFile = (path: string) => {
    if (path === "-") return command.stdin;
    return files.get(path) ?? [...files].find(([written]) => written.endsWith(`/${path}`))?.[1];
  };
  const bodies: Array<string> = [];
  if (sub === "pr comment" || sub === "pr review" || sub === "issue comment") {
    const rest = args.slice(2);
    for (let k = 0; k < rest.length; k++) {
      const arg = rest[k]!;
      const value = rest[k + 1];
      if ((arg === "--body" || arg === "-b") && value !== undefined) bodies.push(unwrap(value));
      else if (arg.startsWith("--body=")) bodies.push(unwrap(arg.slice("--body=".length)));
      else if ((arg === "--body-file" || arg === "-F") && value !== undefined) {
        const text = fromFile(value);
        if (text !== undefined) bodies.push(text);
      }
    }
    const pr = targetOf(rest);
    return {
      sent: bodies.map((body) => ({ body, ...(pr === undefined ? {} : { pr }) })),
      posts: 1,
      reads: false,
    };
  }
  if (args[0] !== "api") return READ;
  let path: string | undefined;
  let method: string | undefined;
  for (let k = 1; k < args.length; k++) {
    const arg = args[k]!;
    const value = args[k + 1];
    if (arg === "-X" || arg === "--method") {
      method = value?.toUpperCase();
      k++;
      continue;
    }
    const field =
      (arg === "-f" || arg === "-F" || arg === "--field" || arg === "--raw-field") &&
      value !== undefined
        ? value
        : arg.startsWith("--field=") || arg.startsWith("--raw-field=")
          ? arg.slice(arg.indexOf("=") + 1)
          : undefined;
    if (field !== undefined) {
      if (!arg.includes("=")) k++;
      if (!field.startsWith("body=")) continue;
      const text = field.slice("body=".length);
      if (text.startsWith("@")) {
        const file = fromFile(text.slice(1));
        if (file !== undefined) bodies.push(file);
      } else bodies.push(unwrap(text));
      continue;
    }
    if (!arg.startsWith("-") && path === undefined) path = arg;
  }
  if (path === undefined || !API_POSTS.test(path) || (method !== undefined && method !== "POST"))
    return READ;
  if (bodies.length === 0) return method === "POST" ? { sent: [], posts: 1, reads: false } : READ;
  const numbered = API_PATH.exec(path);
  const repo = numbered?.[1];
  const pr: PostTarget | undefined =
    numbered === null || numbered === undefined
      ? undefined
      : {
          repo: repo !== undefined && OWNER_REPO.test(repo) ? repo : undefined,
          number: Number(numbered[2]),
        };
  return {
    sent: bodies.map((body) => ({ body, ...(pr === undefined ? {} : { pr }) })),
    posts: 1,
    reads: false,
  };
};

const strings = (value: unknown, out: Array<string>, depth = 0): void => {
  if (depth > 4) return;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const each of value) strings(each, out, depth + 1);
  else if (typeof value === "object" && value !== null)
    for (const each of Object.values(value)) strings(each, out, depth + 1);
};

const COMMENT_LINK =
  /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/\d+#(?:issuecomment-\d+|discussion_r\d+|pullrequestreview-\d+)/g;

interface ToolCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly output: unknown;
  readonly at?: number | undefined;
  readonly key: string;
}

const toolCalls = (messages: ReadonlyArray<GramUIMessage>): Array<ToolCall> =>
  messages.flatMap((message) =>
    message.role !== "assistant"
      ? []
      : message.parts.flatMap((part, index): Array<ToolCall> => {
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
          return [
            {
              name,
              input,
              output: raw.output,
              at: message.metadata?.createdAt,
              key: `${message.id}:${index}`,
            },
          ];
        }),
  );

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** One comment a thread's tool call posted to GitHub. */
export interface Post {
  /** Unique across a thread's calls, so one post explains one comment. */
  readonly key: string;
  /** What it said, by `sameText`; absent when it was built where it can't be read. */
  readonly body?: string | undefined;
  /** The PR it named; absent for the checkout's own, as `gh pr comment` with no number posts to. */
  readonly pr?: PostTarget | undefined;
  /** The GitHub links the posting call printed back: the new comment's own. */
  readonly urls: ReadonlyArray<string>;
  /** When its message was written, epoch ms. */
  readonly at?: number | undefined;
}

/**
 * Every comment `messages` posted to GitHub, with the links the posting call printed. Only a call
 * that posts counts: a read such as `gh pr view --json comments` prints others' links too, and
 * those never make a comment the thread's own.
 */
export const postsIn = (messages: ReadonlyArray<GramUIMessage>): Array<Post> => {
  const calls = toolCalls(messages);
  const files = new Map<string, string>();
  for (const call of calls) {
    const path = str(call.input["file_path"]) ?? str(call.input["path"]);
    const content = str(call.input["content"]);
    if (path !== undefined && content !== undefined) files.set(path, content);
  }
  const posts: Array<Post> = [];
  for (const call of calls) {
    let sent: Array<Sent> = [];
    let posting = 0;
    let reads = false;
    if (call.name.endsWith("pr_reply_to_thread")) {
      posting = 1;
      const body = str(call.input["body"]);
      if (body !== undefined) sent.push({ body });
    }
    const command = call.input["command"] ?? call.input["cmd"];
    const parsed: ReadonlyArray<ShellCommand> = Array.isArray(command)
      ? [{ words: command.filter((w): w is string => typeof w === "string") }]
      : typeof command === "string"
        ? shellCommands(command)
        : [];
    for (const each of parsed) {
      const posted = postingOf(each, files);
      posting += posted.posts;
      reads ||= posted.reads;
      sent = [...sent, ...posted.sent];
    }
    if (posting === 0) continue;
    const printed: Array<string> = [];
    strings(call.output, printed);
    const links = [...new Set(printed.flatMap((text) => text.match(COMMENT_LINK) ?? []))];
    const urls = !reads && links.length <= posting ? links : [];
    const at = call.at;
    if (sent.length === 0) posts.push({ key: call.key, urls, ...(at === undefined ? {} : { at }) });
    sent.forEach((each, i) => {
      const body = sameText(each.body);
      posts.push({
        key: `${call.key}:${i}`,
        ...(body === "" ? {} : { body }),
        ...(each.pr === undefined ? {} : { pr: each.pr }),
        urls,
        ...(at === undefined ? {} : { at }),
      });
    });
  }
  return posts;
};
