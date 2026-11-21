/** A path as written, with the line or range it points at. */
export interface FileRef {
  /** Without the position, `\` turned to `/` unless it's a Windows absolute path. */
  readonly path: string;
  /** 1-based. */
  readonly line?: number | undefined;
  /** The last line of a range; absent for a single line. */
  readonly endLine?: number | undefined;
  readonly column?: number | undefined;
}

const HASH_POSITION = /#L(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C\d+)?)?$/i;
const COLON_POSITION = /:(\d+)(?::(\d+)|-(\d+))?$/;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const EXTENSION = /\.[A-Za-z][\w-]*$/;
const NOT_A_PATH = /[<>|"*?`#\n\r\t{}[\]]|:\/\//;
const HOST = /^(?:www\.)?[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|io|dev|app|ai|co|sh|me|so)$/i;

const FILE_NAMES = new Set([
  "Makefile",
  "Dockerfile",
  "Containerfile",
  "Justfile",
  "Gemfile",
  "Procfile",
  "Brewfile",
  "Jenkinsfile",
  "Vagrantfile",
  "LICENSE",
  "CODEOWNERS",
]);

const positive = (digits: string | undefined) => {
  if (digits === undefined) return undefined;
  const value = Number(digits);
  return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
};

const withPosition = (path: string, line?: string, column?: string, end?: string): FileRef => {
  const start = positive(line);
  const last = positive(end);
  const col = positive(column);
  return {
    path,
    ...(start === undefined ? {} : { line: start }),
    ...(start !== undefined && last !== undefined && last > start ? { endLine: last } : {}),
    ...(start !== undefined && col !== undefined ? { column: col } : {}),
  };
};

/**
 * `text` as a file reference when all of it could be one: a path with a folder, an extension or a
 * well-known name like `Makefile`, and an optional position. Spaces are kept, since a code span or
 * a link says where the path ends. A path with a `..` segment is refused here already: it could
 * only lead out of the checkout, and nothing outside it is ever linked.
 */
export function parseFileRef(text: string): FileRef | undefined {
  let rest = text.trim();
  if (rest === "") return undefined;
  let position: [string | undefined, string | undefined, string | undefined] = [
    undefined,
    undefined,
    undefined,
  ];
  const hash = HASH_POSITION.exec(rest);
  const colon = hash === null ? COLON_POSITION.exec(rest) : null;
  if (hash !== null) position = [hash[1], hash[2], hash[3]];
  else if (colon !== null) position = [colon[1], colon[2], colon[3]];
  const match = hash ?? colon;
  if (match !== null) rest = rest.slice(0, match.index);
  if (rest === "" || rest !== rest.trim() || NOT_A_PATH.test(rest)) return undefined;
  const windows = WINDOWS_ABSOLUTE.test(rest);
  if (!windows && rest.includes(":")) return undefined;
  const path = windows ? rest : rest.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
  const segments = path.split(/[\\/]/);
  if (path === "" || segments.includes("..") || path.endsWith("/") || path.endsWith("\\")) {
    return undefined;
  }
  const name = segments.at(-1)!;
  if (name === "" || name === "." || name === "~") return undefined;
  const nested = segments.length > 1;
  if (!nested && !EXTENSION.test(name) && !FILE_NAMES.has(name)) return undefined;
  if (!windows && !path.startsWith("/") && !path.startsWith("~") && HOST.test(segments[0]!)) {
    return undefined;
  }
  return withPosition(path, ...position);
}

const LEADING = /^[("'‘“[<]+/;
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", '"', "’", "”", "]", ">"]);

const trimTrailing = (token: string) => {
  let end = token.length;
  while (end > 0 && TRAILING.has(token[end - 1]!)) end--;
  return token.slice(0, end);
};

const trimParens = (token: string) => {
  let out = token;
  let open = 0;
  let close = 0;
  for (const char of out) {
    if (char === "(") open++;
    else if (char === ")") close++;
  }
  while (out.endsWith(")") && close > open) {
    out = trimTrailing(out.slice(0, -1));
    close--;
  }
  return out;
};

/** A place in prose that names a file. */
export interface FoundFileRef {
  /** Offsets of the reference in the searched text, position included. */
  readonly start: number;
  readonly end: number;
  readonly ref: FileRef;
}

/**
 * The file references in prose. Stricter than `parseFileRef`, since nothing marks where a path in
 * a sentence starts or ends: it needs a folder and a file name (`src/a.ts`, not `and/or`) or a
 * position (`a.ts:12`), and a space always ends it, so a path with a space is only found in code.
 */
export function findFileRefs(text: string): FoundFileRef[] {
  const found: FoundFileRef[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const raw = match[0];
    const lead = LEADING.exec(raw)?.[0].length ?? 0;
    let token = trimTrailing(raw.slice(lead));
    token = trimParens(token);
    if (token === "" || token.startsWith("@") || /^[a-z][\w+.-]*:\/\//i.test(token)) continue;
    const ref = parseFileRef(token);
    if (ref === undefined) continue;
    const name = ref.path.split(/[\\/]/).at(-1)!;
    const named = EXTENSION.test(name) || FILE_NAMES.has(name);
    if (ref.line === undefined && !(named && /[\\/]/.test(ref.path))) continue;
    const start = match.index + lead;
    found.push({ start, end: start + token.length, ref });
  }
  return found;
}

/**
 * A markdown link's `href` as a file reference: a relative path, an absolute one, or a `file://`
 * URL, with an optional `#L` position. Web links, mail links and in-page anchors are none.
 */
export function hrefFileRef(href: string): FileRef | undefined {
  const trimmed = href.trim();
  if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("//")) return undefined;
  let target = trimmed;
  if (/^file:\/\//i.test(target)) {
    target = target.slice("file://".length);
    if (/^\/[A-Za-z]:\//.test(target)) target = target.slice(1);
  } else if (/^[a-z][a-z\d+.-]*:/i.test(target) && !WINDOWS_ABSOLUTE.test(target)) {
    return undefined;
  }
  try {
    target = decodeURIComponent(target);
  } catch {
    return undefined;
  }
  const query = target.indexOf("?");
  if (query !== -1) {
    const hash = target.indexOf("#", query);
    target = target.slice(0, query) + (hash === -1 ? "" : target.slice(hash));
  }
  return parseFileRef(target);
}

const QUOTE_MARKER = / {0,3}> ?/y;
const isBlank = (char: string | undefined) => char === " " || char === "\t";

function listMarkersLength(line: string): number {
  let end = 0;
  for (let i = 0; ;) {
    while (isBlank(line[i])) i++;
    let after = i;
    if (line[i] === "-" || line[i] === "+" || line[i] === "*") {
      after = i + 1;
    } else {
      while (
        after - i < 9 &&
        line[after] !== undefined &&
        line[after]! >= "0" &&
        line[after]! <= "9"
      )
        after++;
      if (after === i || (line[after] !== "." && line[after] !== ")")) return end;
      after++;
    }
    if (!isBlank(line[after])) return end;
    i = after;
    while (isBlank(line[i])) i++;
    end = i;
  }
}
const FENCE_RUN = /^([ \t]*)(`{3,}|~{3,})/;
const FENCE_CLOSER = /^( *)(`{3,}|~{3,})[ \t]*$/;
const INDENTED = /^(?: {4}|\t)/;
const OPAQUE_HTML = /<(pre|code|kbd|samp|a|script|style|textarea|template)(?=[\s>/])/iy;
const AUTOLINK = /<([a-z][a-z\d+.-]{1,31}:[^\s<>]*)>/iy;
const DEFINITION = /^ {0,3}\[[^\]\n]*\]:/;
const LINK_TEXT_MAX = 1000;
const DESTINATION_MAX = 4096;
const LINK_SCAN_BUDGET = 1_000_000;

interface Budget {
  left: number;
}
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

function withoutBlocks(markdown: string): string {
  const kept: string[] = [];
  let fence: { run: string; column: number; depth: number } | undefined;
  for (const line of markdown.split("\n")) {
    let offset = 0;
    let depth = 0;
    const limit = fence === undefined ? Number.POSITIVE_INFINITY : fence.depth;
    while (depth < limit) {
      QUOTE_MARKER.lastIndex = offset;
      const marker = QUOTE_MARKER.exec(line);
      if (marker === null) break;
      offset += marker[0].length;
      depth++;
    }
    const content = line.slice(offset);
    if (fence !== undefined && depth >= fence.depth) {
      const closer = FENCE_CLOSER.exec(content);
      const closes =
        closer !== null &&
        closer[2]![0] === fence.run[0] &&
        closer[2]!.length >= fence.run.length &&
        closer[1]!.length >= Math.max(0, fence.column - 3) &&
        closer[1]!.length <= fence.column + 3;
      if (closes) fence = undefined;
      kept.push("");
      continue;
    }
    fence = undefined;
    const listed = listMarkersLength(content);
    const opener = FENCE_RUN.exec(content.slice(listed));
    if (opener !== null) {
      fence = { run: opener[2]!, column: listed + opener[1]!.length, depth };
      kept.push("");
      continue;
    }
    kept.push(INDENTED.test(content) || DEFINITION.test(content) ? "" : line);
  }
  return kept.join("\n");
}

const findOnLine = (text: string, char: string, from: number, budget: Budget) => {
  for (let i = from; i < text.length && i - from <= DESTINATION_MAX; i++, budget.left--) {
    if (text[i] === char) return i;
    if (text[i] === "\n") return -1;
  }
  return -1;
};

function backtickRuns(text: string): Map<number, number[]> {
  const runs = new Map<number, number[]>();
  for (let i = 0; i < text.length;) {
    if (text[i] === "\\" && text[i + 1] === "`") {
      i += 2;
      continue;
    }
    if (text[i] !== "`") {
      i++;
      continue;
    }
    let end = i;
    while (text[end] === "`") end++;
    const length = end - i;
    if (!runs.has(length)) runs.set(length, []);
    runs.get(length)!.push(i);
    i = end;
  }
  return runs;
}

function linkDestination(
  text: string,
  at: number,
  budget: Budget,
): { end: number; target: string } | undefined {
  let i = at + 1;
  while (text[i] === " " || text[i] === "\t") i++;
  let target: string;
  if (text[i] === "<") {
    const close = findOnLine(text, ">", i, budget);
    if (close === -1) return undefined;
    target = text.slice(i + 1, close);
    i = close + 1;
  } else {
    const start = i;
    let depth = 0;
    for (; i < text.length && text.charCodeAt(i) > 32; i++, budget.left--) {
      if (i - start > DESTINATION_MAX) return undefined;
      if (text[i] === "\\") i++;
      else if (text[i] === "(") depth++;
      else if (text[i] === ")" && depth-- === 0) break;
    }
    target = text.slice(start, i);
  }
  while (text[i] === " " || text[i] === "\t") i++;
  const quote = text[i];
  if (quote === '"' || quote === "'" || quote === "(") {
    const close = findOnLine(text, quote === "(" ? ")" : quote, i + 1, budget);
    if (close === -1) return undefined;
    i = close + 1;
    while (text[i] === " " || text[i] === "\t") i++;
  }
  return text[i] === ")" ? { end: i + 1, target } : undefined;
}

/**
 * The file references `markdown` holds by the renderer's rules, read from its source with the
 * renderer's precedence: code blocks are skipped; inline, whatever opens first binds, so a link or
 * an HTML comment inside a code span is literal code, and HTML comments and opaque HTML elements
 * outside one are skipped; a link's target is read through `hrefFileRef` and its text
 * never; an inline code span whose whole text is a path through `parseFileRef`; and the prose left
 * through `findFileRefs`. Images, reference-style links and their definitions are skipped. Wherever it can't be sure
 * the renderer links something it reads nothing, so what it returns is never more than the renderer
 * links. Linear in the text, which a message controls. For the server, which reads outside a
 * thread's checkouts only a path its messages wrote.
 */
export function writtenFileRefs(markdown: string): FileRef[] {
  const text = withoutBlocks(markdown);
  const lower = text.toLowerCase();
  const runs = backtickRuns(text);
  const closing = (length: number, from: number) => {
    const starts = runs.get(length) ?? [];
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (starts[middle]! <= from) low = middle + 1;
      else high = middle;
    }
    return starts[low] ?? -1;
  };
  const codeSpanEnd = (at: number) => {
    let end = at;
    while (text[end] === "`") end++;
    const close = closing(end - at, at);
    return close === -1 ? -1 : close + (end - at);
  };

  const budget: Budget = { left: LINK_SCAN_BUDGET };
  const refs: FileRef[] = [];
  const keep = (ref: FileRef | undefined) => {
    if (ref !== undefined) refs.push(ref);
  };
  let prose = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (char === "\\" && ASCII_PUNCTUATION.test(text[i + 1] ?? "")) {
      prose += text[i + 1];
      i += 2;
      continue;
    }
    if (char === "`") {
      let run = i;
      while (text[run] === "`") run++;
      const end = codeSpanEnd(i);
      if (end === -1) {
        prose += text.slice(i, run);
        i = run;
        continue;
      }
      const length = run - i;
      keep(parseFileRef(text.slice(run, end - length).replaceAll("\n", " ")));
      prose += " ";
      i = end;
      continue;
    }
    if (char === "<") {
      AUTOLINK.lastIndex = i;
      const autolink = AUTOLINK.exec(text);
      if (autolink !== null) {
        keep(hrefFileRef(autolink[1]!));
        prose += " ";
        i += autolink[0].length;
        continue;
      }
      if (text.startsWith("<!--", i)) {
        const end = text.indexOf("-->", i + 4);
        prose += " ";
        i = end === -1 ? text.length : end + 3;
        continue;
      }
      OPAQUE_HTML.lastIndex = i;
      const element = OPAQUE_HTML.exec(text);
      if (element !== null) {
        const close = lower.indexOf(`</${element[1]!.toLowerCase()}`, i);
        prose += " ";
        i = close === -1 ? text.length : close;
        continue;
      }
    }
    const image = char === "!" && text[i + 1] === "[";
    if (char === "[" || image) {
      const open = image ? i + 1 : i;
      let depth = 0;
      let close = -1;
      for (let j = open + 1; j < text.length && j - open <= LINK_TEXT_MAX; j++, budget.left--) {
        const inner = text[j];
        if (inner === "\\") j++;
        else if (inner === "\n" && text[j + 1] === "\n") break;
        else if (inner === "`") {
          const end = codeSpanEnd(j);
          if (end !== -1) j = end - 1;
          else while (text[j + 1] === "`") j++;
        } else if (inner === "[") depth++;
        else if (inner === "]" && depth-- === 0) {
          close = j;
          break;
        }
      }
      const destination =
        close !== -1 && text[close + 1] === "("
          ? linkDestination(text, close + 1, budget)
          : undefined;
      if (budget.left < 0) break;
      if (destination !== undefined) {
        if (!image) keep(hrefFileRef(destination.target));
        prose += " ";
        i = destination.end;
        continue;
      }
      prose += text.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    if (char === "*") {
      let end = i;
      while (text[end] === "*") end++;
      const outer = (at: number) => at < 0 || at >= text.length || /\s/.test(text[at]!);
      prose += outer(i - 1) || outer(end) ? " " : text.slice(i, end);
      i = end;
      continue;
    }
    prose += char;
    i++;
  }
  for (const found of findFileRefs(prose)) refs.push(found.ref);
  return refs;
}
