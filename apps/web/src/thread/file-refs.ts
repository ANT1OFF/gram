// File paths in an agent's text, found where the markdown is rendered. Like PR references
// (`pr-refs.ts`), the renderer finds them and nothing asks the model to mark them: this module only
// says what could be a path, and `fs.resolve` decides what is, so a path links only when it names
// one file. A path into the thread's checkouts is asked about as it renders; an absolute one
// elsewhere only when it's pointed at. A wrong link is worse than none.

import { findFileRefs, hrefFileRef, parseFileRef, type FileRef } from "@gram/contracts";

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

const normal = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "");

/** Whether `path` starts at the filesystem's root, a drive or the home folder (`~`). */
export const isAbsoluteRef = (path: string): boolean =>
  path.startsWith("/") || path.startsWith("~") || WINDOWS_ABSOLUTE.test(path);

/**
 * Whether `path` is in a thread with these checkout `roots`, so it's resolved as it renders:
 * anything relative, and an absolute path inside a root. Any other path is absolute, somewhere
 * else on the machine, and asked about only once it's pointed at.
 */
export function mayBeInRoots(path: string, roots: readonly string[]): boolean {
  if (!isAbsoluteRef(path)) return true;
  const target = normal(path);
  return roots.some((root) => {
    const base = normal(root);
    return base !== "" && target.startsWith(`${base}/`);
  });
}

/** `12`, `12:5` or `12–20`, for a tooltip; empty without a line. */
export function positionLabel(ref: Pick<FileRef, "line" | "endLine" | "column">): string {
  if (ref.line === undefined) return "";
  if (ref.endLine !== undefined) return `${ref.line}–${ref.endLine}`;
  return ref.column === undefined ? `${ref.line}` : `${ref.line}:${ref.column}`;
}

/** The custom element a reference renders as; its component resolves it. */
export const FILE_REF_TAG = "file-ref";

interface HastText {
  type: "text";
  value: string;
}

interface HastElement {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
}

type HastNode = HastText | HastElement | { type: string; children?: HastNode[] };

/** Whose text is never read for paths: code blocks, keys, and what is already a reference. */
const OPAQUE = new Set(["pre", "kbd", "samp", "pr-ref", "thread-ref", FILE_REF_TAG]);

const refElement = (ref: FileRef, children: HastNode[], kind: "code" | "text" | "link") => ({
  type: "element" as const,
  tagName: FILE_REF_TAG,
  properties: {
    dataPath: ref.path,
    dataKind: kind,
    ...(ref.line === undefined ? {} : { dataLine: String(ref.line) }),
    ...(ref.endLine === undefined ? {} : { dataEnd: String(ref.endLine) }),
    ...(ref.column === undefined ? {} : { dataColumn: String(ref.column) }),
  },
  children,
});

const textOf = (node: HastNode): string =>
  node.type === "text"
    ? (node as HastText).value
    : ((node as { children?: HastNode[] }).children ?? []).map(textOf).join("");

function splitFileRefs(text: HastText): HastNode[] {
  const found = findFileRefs(text.value);
  if (found.length === 0) return [text];
  const out: HastNode[] = [];
  let last = 0;
  for (const { start, end, ref } of found) {
    if (start > last) out.push({ type: "text", value: text.value.slice(last, start) });
    out.push(refElement(ref, [{ type: "text", value: text.value.slice(start, end) }], "text"));
    last = end;
  }
  if (last < text.value.length) out.push({ type: "text", value: text.value.slice(last) });
  return out;
}

const visit = (node: HastNode): void => {
  if (!("children" in node) || node.children === undefined) return;
  const next: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text") {
      next.push(...splitFileRefs(child as HastText));
      continue;
    }
    if (child.type === "element") {
      const element = child as HastElement;
      if (element.tagName === "code") {
        const ref = parseFileRef(textOf(element));
        next.push(ref === undefined ? element : refElement(ref, [element], "code"));
        continue;
      }
      if (element.tagName === "a") {
        const href = element.properties?.["href"];
        const ref = typeof href === "string" ? hrefFileRef(href) : undefined;
        next.push(ref === undefined ? element : refElement(ref, element.children, "link"));
        continue;
      }
      if (!OPAQUE.has(element.tagName)) visit(element);
    }
    next.push(child);
  }
  node.children = next;
};

/**
 * A rehype plugin, run after sanitizing and before `harden`, that marks every path that could
 * be a file for the `file-ref` component: inline code whose whole text is one, a markdown link to
 * one, and one in prose. Code blocks are left alone. Whether one links is decided at render.
 */
export const rehypeFileRefs = () => (tree: HastNode) => visit(tree);
