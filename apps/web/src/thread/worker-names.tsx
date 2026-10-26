import type { ThreadId } from "@gram/contracts";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

// Worker names in an orchestrator's messages as links to the worker views ("From a message",
// buildout "Reaching workers"). A rehype pass after the PR references: it marks each whole-word
// occurrence of a worker's title, longest first, outside code, links and headings.

export const WORKER_REF_TAG = "worker-ref";

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

export interface WorkerNameRef {
  readonly threadId: ThreadId;
  readonly title: string;
}

const OPAQUE = new Set([
  "code",
  "pre",
  "kbd",
  "samp",
  "a",
  "thread-ref",
  "pr-ref",
  "file-ref",
  WORKER_REF_TAG,
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

/** Names shorter than this read as ordinary words too often to link. */
const MIN_NAME = 4;

const escape = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One pattern for every name, longest first, matching whole words only. */
const workerNamePattern = (names: readonly WorkerNameRef[]): RegExp | undefined => {
  const usable = names
    .filter((name) => name.title.trim().length >= MIN_NAME)
    .toSorted((a, b) => b.title.length - a.title.length);
  if (usable.length === 0) return undefined;
  return new RegExp(
    `(?<![\\w-])(${usable.map((name) => escape(name.title)).join("|")})(?![\\w-])`,
    "g",
  );
};

function split(
  text: HastText,
  pattern: RegExp,
  byTitle: ReadonlyMap<string, ThreadId>,
): HastNode[] {
  const out: HastNode[] = [];
  let last = 0;
  for (const match of text.value.matchAll(pattern)) {
    const id = byTitle.get(match[1]!);
    if (id === undefined) continue;
    if (match.index > last) out.push({ type: "text", value: text.value.slice(last, match.index) });
    out.push({
      type: "element",
      tagName: WORKER_REF_TAG,
      properties: { dataThreadId: id },
      children: [{ type: "text", value: match[1]! }],
    });
    last = match.index + match[1]!.length;
  }
  if (out.length === 0) return [text];
  if (last < text.value.length) out.push({ type: "text", value: text.value.slice(last) });
  return out;
}

/** A rehype plugin over `names`; a title two workers share links to neither. */
export const rehypeWorkerNames = (names: readonly WorkerNameRef[]) => {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name.title, (counts.get(name.title) ?? 0) + 1);
  const unique = names.filter((name) => counts.get(name.title) === 1);
  const pattern = workerNamePattern(unique);
  const byTitle = new Map(unique.map((name) => [name.title, name.threadId]));
  const visit = (node: HastNode): void => {
    if (pattern === undefined || !("children" in node) || node.children === undefined) return;
    const next: HastNode[] = [];
    for (const child of node.children) {
      if (child.type === "text") {
        next.push(...split(child as HastText, pattern, byTitle));
        continue;
      }
      if (child.type === "element" && !OPAQUE.has((child as HastElement).tagName)) visit(child);
      next.push(child);
    }
    node.children = next;
  };
  return () => (tree: HastNode) => visit(tree);
};

function WorkerRef({
  "data-thread-id": id,
  children,
}: {
  "data-thread-id"?: string;
  children?: ReactNode;
}) {
  if (id === undefined) return <>{children}</>;
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: id as ThreadId }}
      data-testid="worker-name-link"
      className="font-medium text-primary underline underline-offset-2"
    >
      {children}
    </Link>
  );
}

export const WORKER_REF_COMPONENTS = { [WORKER_REF_TAG]: WorkerRef };
