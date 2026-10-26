import {
  searchSnippet,
  type FileImage,
  type FsEntry,
  type FsFile,
  type FsFileName,
  type FsFilesResult,
  type FsListing,
  type FsResolveResult,
  type FsSearchMatch,
  type FsSearchResult,
} from "@gram/contracts";

type MockNode =
  | { kind: "dir"; children: Record<string, MockNode> }
  | { kind: "file"; content?: string; size?: number; binary?: boolean; image?: string }
  | { kind: "symlink"; target: string };

/** A 160×96 PNG: big enough that a preview or a transcript thumbnail of it can be judged. */
const LOGO_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAKAAAABgCAIAAAAVRe7OAAABf0lEQVR42u3dMQoCURAE0b2JR/S+HsDETAwEE28gLux0f+VBxxVMxcVs98fT/nibExBsBBvBRrARbAQbwQQbwUawEWwEG8FGMMFf7nS+7drl+to1/M9bSzC7h/MXEszuBH8VwewO8ZcQzO4cvy+Y3VF+WTC70/ymYNcP8GuCXT/D7wh2/Ri/INj1k/y0YNcP86OCXT/Pzwl2/Qo/JNj1W/yEYNcv8scFu36Xv5Zgdg/nLySY3Qn+KoLZHeIvIZjdOX5fMLuj/LJgdqf5TcGuH+DXBLt+ht8R7PoxfkGw6yf5acGuH+ZHBbt+np8T7PoVfkiw67f4CcGuX+Trg/XB+mB9sD5YH+z6+mB29cHs6oPx9cH6YH2wPlgfrA/WB+uD2dUHs6sPxtcH64P1wfpgfbA+WB+sD3Z9fTC7+mB29cH4+mB9sD5YH6wP1ge7vj6YXX0wu/pgfH2wPlgfrA/WB+uDzQdwI9gINoKNYCOYYCPYCDaCjWAj2Agm2Ai239obh0qQnmukN0EAAAAASUVORK5CYII=";

/**
 * The copy of `docs/logo.png` the mock "stored" for a tool call that read it, named by content hash
 * under the data dir as the server names its own.
 */
export const MOCK_TOOL_IMAGE = {
  path: "/Users/dev/Library/Application Support/gram-state/attachments/t-mock/tool-5f1d0c9a3b7e2d46.png",
  mediaType: "image/png",
  size: 440,
  base64: LOGO_PNG,
};

/** Carries a script, which must never run: previews render SVG through `<img>`. */
const DIAGRAM_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><script>window.__svgScriptRan = true</script><rect width="120" height="40" fill="#7aa2f7"/></svg>';

const ARCHITECTURE_MD = `# Architecture

Requests go through [retry](../src/retry.ts) before they reach the network.

![Logo](logo.png)

![Flow](./diagram.svg)

See the [README](/README.md) and the [upstream docs](https://organization.example.invalid/docs).
`;

const dir = (children: Record<string, MockNode>): MockNode => ({ kind: "dir", children });
const text = (content: string): MockNode => ({ kind: "file", content });

const RETRY_TS = `import { sleep } from "./clock";

export interface RetryOptions {
  attempts: number;
  backoffMs: number;
}

/** Runs \`fn\` until it succeeds or the attempts run out. */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < options.attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await sleep(options.backoffMs * 2 ** attempt);
    }
  }
  throw lastError;
}
`;

const RETRY_TEST_TS = `import { describe, expect, it } from "vitest";

import { retry } from "./retry";

describe("retry", () => {
  it("gives up after the last attempt", async () => {
    await expect(retry(() => Promise.reject(new Error("nope")), { attempts: 3, backoffMs: 0 })).rejects.toThrow("nope");
  });
});
`;

/** Every seeded checkout (and its worktrees) shows this tree. */
const CHECKOUT = dir({
  ".git": dir({ HEAD: text("ref: refs/heads/main\n") }),
  ".github": dir({
    workflows: dir({
      "ci.yml": text(
        "name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v5\n      - run: pnpm test\n",
      ),
    }),
  }),
  ".env.example": text("API_URL=http://localhost:3000\n"),
  ".gitignore": text("dist/\n"),
  dist: dir({ "index.js": text('export { retry } from "./retry.js";\n') }),
  docs: dir({
    "architecture.md": text(ARCHITECTURE_MD),
    "diagram.svg": { kind: "file", content: DIAGRAM_SVG, image: btoa(DIAGRAM_SVG) },
    "font.woff2": { kind: "file", size: 24_512, binary: true },
    "logo.png": { kind: "file", size: 440, binary: true, image: LOGO_PNG },
  }),
  fixtures: dir({ "recording.json": { kind: "file", size: 5_242_880 } }),
  src: dir({
    "clock.ts": text(
      "export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));\n",
    ),
    "index.ts": text('export { retry } from "./retry";\n'),
    "retry.test.ts": text(RETRY_TEST_TS),
    "retry.ts": text(RETRY_TS),
  }),
  latest: { kind: "symlink", target: "src" },
  "package.json": text(
    `${JSON.stringify({ name: "api", private: true, scripts: { test: "vitest run" } }, null, 2)}\n`,
  ),
  "README.md": text("# api\n\nThe API service. Run `pnpm test` to check retries.\n"),
});

const RESEARCH_MD = `# Browser research

Three of the five sites block automation; details below.

![Login page](./login.png)

| Site | Blocks |
| ---- | ------ |
| a    | yes    |
`;

/** Files outside every checkout, named by absolute path, for links to paths an agent wrote. */
const ELSEWHERE = dir({
  tmp: dir({
    "browser-research": dir({
      "REPORT.md": text(RESEARCH_MD),
      "login.png": { kind: "file", size: 440, binary: true, image: LOGO_PNG },
      "notes.txt": text("one\ntwo\nthree\nfour\nfive\n"),
    }),
  }),
  Users: dir({
    dev: dir({
      ".aws": dir({ credentials: text("[default]\naws_access_key_id = MOCK\n") }),
    }),
  }),
});

/** The mock's home folder, which `~` stands for. */
const MOCK_HOME = "/Users/dev";

/** `path` with a leading `~` spelled out as the mock's home. */
export const expandMockHome = (path: string) =>
  path === "~" || path.startsWith("~/") ? `${MOCK_HOME}${path.slice(1)}` : path;

/** Top-level names the checkout's `.gitignore` matches. */
const IGNORED = new Set(["dist"]);

const CHECKOUT_RE = /^\/Users\/dev\/code\/(?:api|web|docs)(?:\/\.worktrees\/[^/]+)?((?:\/[^/]+)*)$/;
const MODIFIED_AT = Date.UTC(2026, 8, 16, 9, 30);
const LANGUAGES: Record<string, string> = {
  css: "css",
  js: "javascript",
  json: "json",
  md: "markdown",
  ts: "typescript",
  tsx: "tsx",
  yml: "yaml",
  yaml: "yaml",
};

const trimSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);
const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

function locate(path: string): MockNode | undefined {
  const match = CHECKOUT_RE.exec(trimSlash(path));
  let node: MockNode | undefined = match ? CHECKOUT : ELSEWHERE;
  const rest = match ? (match[1] ?? "") : path.startsWith("/") ? path : "";
  if (!match && rest === "") return undefined;
  for (const segment of rest.split("/").filter(Boolean)) {
    node = node?.kind === "dir" ? node.children[segment] : undefined;
  }
  return node;
}

const sizeOf = (node: MockNode) =>
  node.kind === "file" ? (node.size ?? new TextEncoder().encode(node.content ?? "").length) : 0;

const notFound = (path: string) =>
  Object.assign(new Error(`Not found: ${path}`), { _tag: "NotFound", entity: "file", id: path });
const invalidState = (message: string) =>
  Object.assign(new Error(message), { _tag: "InvalidState" });

/**
 * `fs.list` over the seeded checkouts: folders first; dotfiles and git-ignored entries only when
 * `showHidden`.
 */
export function listMockFiles(
  input: string,
  options: { showHidden?: boolean; limit?: number } = {},
): FsListing {
  const path = trimSlash(input);
  const node = locate(path);
  if (!node) throw notFound(path);
  if (node.kind !== "dir") throw invalidState(`Not a folder: ${path}`);
  const atRoot = (CHECKOUT_RE.exec(path)?.[1] ?? "") === "";
  const entries: FsEntry[] = Object.entries(node.children)
    .filter(
      ([name]) =>
        options.showHidden === true || !(name.startsWith(".") || (atRoot && IGNORED.has(name))),
    )
    .map(([name, child]) => ({
      name,
      path: `${path}/${name}`,
      kind: child.kind,
      ...(child.kind === "file" ? { size: sizeOf(child) } : {}),
      modifiedAt: MODIFIED_AT,
    }))
    .toSorted(
      (a, b) =>
        Number(b.kind === "dir") - Number(a.kind === "dir") ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
  const limit = options.limit ?? 1000;
  return {
    path,
    parent: parentOf(path),
    entries: entries.slice(0, limit),
    truncated: entries.length > limit,
  };
}

/** The server's default preview cap. */
export const MOCK_MAX_BYTES = 512 * 1024;

/**
 * Resolves `input` against a thread checkout as `fs.list` / `fs.file` do with a `threadId`:
 * relative paths start at the checkout, and anything that escapes it is rejected.
 */
export function resolveInCheckout(input: string, root: string): string {
  const joined = input.startsWith("/") ? input : `${root}/${input}`;
  const segments: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const path = `/${segments.join("/")}`;
  if (path !== root && !path.startsWith(`${root}/`)) {
    throw invalidState(`${input} is outside this thread's folder`);
  }
  return path;
}

/** `fs.file`: text with a language id, or the binary / too-large flags. */
export function readMockFile(input: string, options: { maxBytes?: number } = {}): FsFile {
  const path = trimSlash(input);
  const node = locate(path);
  if (!node) throw notFound(path);
  if (node.kind !== "file") throw invalidState(`Not a file: ${path}`);
  const size = sizeOf(node);
  const extension = path.slice(path.lastIndexOf(".") + 1);
  const language = LANGUAGES[extension];
  const base = { path, size, ...(language ? { language } : {}) };
  if (node.binary) return { path, size, binary: true, tooLarge: false };
  if (node.content === undefined || size > (options.maxBytes ?? MOCK_MAX_BYTES)) {
    return { ...base, binary: false, tooLarge: true };
  }
  return { ...base, binary: false, tooLarge: false, content: node.content };
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** `fs.image`: the seeded images as base64; anything else is refused like the server does. */
export function readMockImage(input: string, options: { maxBytes?: number } = {}): FileImage {
  const path = trimSlash(input);
  const node = locate(path);
  if (!node) throw notFound(path);
  if (node.kind !== "file") throw invalidState(`Not a file: ${path}`);
  const mediaType = IMAGE_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];
  if (mediaType === undefined || node.image === undefined) {
    throw invalidState(`Not a previewable image: ${path}`);
  }
  const size = sizeOf(node);
  if (size > (options.maxBytes ?? 5 * 1024 * 1024))
    return { path, mediaType, size, tooLarge: true };
  return { path, mediaType, size, tooLarge: false, base64: node.image };
}

/** Decoded bytes of a base64 payload, which inflates by a third. */
const base64Size = (base64: string) =>
  (base64.length * 3) / 4 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);

/**
 * `attachment.read`: an uploaded attachment's own bytes, kept by `MockApi.uploadAttachment`. A
 * path with no upload behind it is a file dragged from disk, served from the seeded tree.
 */
export function readMockAttachment(
  path: string,
  uploaded: string | undefined,
  options: { maxBytes?: number } = {},
): FileImage {
  if (uploaded === undefined) return readMockImage(path, options);
  const mediaType = IMAGE_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];
  if (mediaType === undefined) throw invalidState(`Not a previewable image: ${path}`);
  const size = Math.round(base64Size(uploaded));
  if (size > (options.maxBytes ?? 5 * 1024 * 1024))
    return { path, mediaType, size, tooLarge: true };
  return { path, mediaType, size, tooLarge: false, base64: uploaded };
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `fs.search` over the seeded checkout: text files outside `.git` and the git-ignored folders,
 * sorted by path and line, paged like the server.
 */
export function searchMockFiles(
  root: string,
  query: string,
  options: { regex?: boolean; caseSensitive?: boolean; offset?: number; limit?: number } = {},
): FsSearchResult {
  const node = locate(root);
  if (!node || node.kind !== "dir") throw notFound(root);
  if (query.trim() === "") throw invalidState("Enter something to search for");
  let pattern: RegExp;
  try {
    pattern = new RegExp(
      options.regex ? query : escapeRegExp(query),
      options.caseSensitive ? "" : "i",
    );
  } catch (error) {
    throw invalidState(`Invalid regular expression: ${(error as Error).message}`);
  }
  const matches: FsSearchMatch[] = [];
  const walk = (dirNode: Extract<MockNode, { kind: "dir" }>, prefix: string) => {
    for (const [name, child] of Object.entries(dirNode.children)) {
      if (name === ".git" || (prefix === "" && IGNORED.has(name))) continue;
      const relativePath = `${prefix}${name}`;
      if (child.kind === "dir") walk(child, `${relativePath}/`);
      if (child.kind !== "file" || child.binary || child.content === undefined) continue;
      for (const [index, lineText] of child.content.split("\n").entries()) {
        if (!pattern.test(lineText)) continue;
        matches.push({
          path: `${trimSlash(root)}/${relativePath}`,
          relativePath,
          line: index + 1,
          ...searchSnippet(lineText, query, options),
        });
      }
    }
  };
  walk(node, "");
  matches.sort((a, b) =>
    a.relativePath === b.relativePath ? a.line - b.line : a.relativePath < b.relativePath ? -1 : 1,
  );
  const offset = options.offset ?? 0;
  const end = Math.min(offset + (options.limit ?? 200), matches.length);
  return {
    matches: matches.slice(offset, end),
    ...(end < matches.length ? { nextOffset: end } : {}),
  };
}

/**
 * `fs.files` over the seeded checkout: every file and folder outside `.git`, `node_modules` and the
 * git-ignored folders, sorted by path.
 */
export function listMockFileNames(root: string): FsFilesResult {
  const node = locate(root);
  if (!node || node.kind !== "dir") throw notFound(root);
  const entries: FsFileName[] = [];
  const walk = (dirNode: Extract<MockNode, { kind: "dir" }>, prefix: string) => {
    for (const [name, child] of Object.entries(dirNode.children)) {
      if (name === ".git" || name === "node_modules" || (prefix === "" && IGNORED.has(name))) {
        continue;
      }
      const path = `${prefix}${name}`;
      entries.push({ path, kind: child.kind === "dir" ? "dir" : "file" });
      if (child.kind === "dir") walk(child, `${path}/`);
    }
  };
  walk(node, "");
  return {
    entries: entries.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    truncated: false,
  };
}

/** `path` as a file in `root`, or none. */
const mockFileIn = (path: string, root: string): string[] => {
  try {
    const target = resolveInCheckout(path, root);
    return locate(target)?.kind === "file" ? [target] : [];
  } catch {
    // Outside the root: never a link.
    return [];
  }
};

/** `fs.resolve` over the seeded checkouts, by the same rules as the server's. */
export function resolveMockFileRefs(
  paths: readonly string[],
  roots: readonly string[],
  mentioned: (path: string) => boolean = () => false,
): FsResolveResult {
  const one = (path: string) => {
    const expanded = expandMockHome(path);
    const absolute = expanded.startsWith("/");
    const candidates = absolute
      ? roots.filter((root) => expanded.startsWith(`${root}/`)).slice(0, 1)
      : roots;
    if (absolute && candidates.length === 0) {
      // In no checkout: only checked to be a file, and only when the thread wrote it.
      if (!mentioned(path)) return [];
      return locate(expanded)?.kind === "file" ? [{ path, resolved: trimSlash(expanded) }] : [];
    }
    const found = candidates.flatMap((root) => mockFileIn(path, root));
    if (absolute || path.includes("/")) {
      return found.length === 1 ? [{ path, resolved: found[0]! }] : [];
    }
    const named = new Set([
      ...found,
      ...roots.flatMap((root) =>
        listMockFileNames(root)
          .entries.filter((entry) => entry.kind === "file" && entry.path.split("/").at(-1) === path)
          .map((entry) => `${root}/${entry.path}`),
      ),
    ]);
    return named.size === 1 ? [{ path, resolved: [...named][0]! }] : [];
  };
  return { files: [...new Set(paths)].flatMap(one) };
}
