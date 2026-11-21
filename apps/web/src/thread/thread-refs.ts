const THREAD_UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

const FRAGMENT_ID = /^[A-Za-z\d][\w-]{0,127}$/;

/** The id `href` names when it is a bare fragment that could be a thread's, else nothing. */
export function threadLinkId(href: string): string | undefined {
  if (!href.startsWith("#")) return undefined;
  const id = href.slice(1);
  return FRAGMENT_ID.test(id) ? id : undefined;
}

/** What a possible thread link renders as. */
export type ThreadRefTarget =
  | { readonly kind: "thread"; readonly title: string }
  | { readonly kind: "gone" }
  | { readonly kind: "none" };

/**
 * Where the link to `id` goes: a thread the store knows by it, under its current title; a
 * UUID-shaped id it doesn't know, once the store has loaded; and otherwise nothing. Before the
 * first snapshot nothing is known, so an unknown id isn't called gone yet.
 */
export function resolveThreadRef(
  id: string,
  titleOf: (id: string) => string | undefined,
  ready: boolean,
): ThreadRefTarget {
  const title = titleOf(id);
  if (title !== undefined) return { kind: "thread", title };
  return ready && THREAD_UUID.test(id) ? { kind: "gone" } : { kind: "none" };
}

/** A run of plain text, or a `[label](#id)` link written in it. */
export type ThreadTextSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "link"; readonly id: string; readonly label: string; readonly raw: string };

const TEXT_LINK = /\[([^\]\n]{1,200})\]\(#([A-Za-z\d][\w-]{0,127})\)/g;

/**
 * `text` cut where it holds `[label](#id)` links, for text shown plain rather than as markdown (a
 * message another thread sent). Every such link is a segment; the component decides which are
 * threads, and writes the rest back as `raw`.
 */
export function splitThreadLinks(text: string): ThreadTextSegment[] {
  const out: ThreadTextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(TEXT_LINK)) {
    if (match.index > last) out.push({ kind: "text", text: text.slice(last, match.index) });
    out.push({ kind: "link", id: match[2]!, label: match[1]!, raw: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/** The custom element a possible thread link renders as; its component resolves it. */
export const THREAD_REF_TAG = "thread-ref";

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

const OPAQUE = new Set(["code", "pre", "kbd", "samp"]);

const textOf = (node: HastNode): string =>
  node.type === "text"
    ? (node as HastText).value
    : ((node as { children?: HastNode[] }).children ?? []).map(textOf).join("");

const visit = (node: HastNode): void => {
  if (!("children" in node) || node.children === undefined) return;
  node.children = node.children.map((child) => {
    if (child.type !== "element") return child;
    const element = child as HastElement;
    if (element.tagName === "a") {
      const href = element.properties?.["href"];
      const id = typeof href === "string" ? threadLinkId(href) : undefined;
      if (id === undefined) return element;
      return {
        type: "element",
        tagName: THREAD_REF_TAG,
        properties: { dataThreadId: id, dataLabel: textOf(element) },
        children: [element],
      } satisfies HastElement;
    }
    if (!OPAQUE.has(element.tagName)) visit(element);
    return element;
  });
};

/**
 * A rehype plugin, run after sanitizing and before the file and PR references, that marks every
 * `[title](#id)` link for the `thread-ref` component. Whether one is a thread is decided at render.
 */
export const rehypeThreadRefs = () => (tree: HastNode) => visit(tree);
