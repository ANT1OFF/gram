/** A text node of the HTML tree (hast) the transcript's markdown renders to. */
export interface HastText {
  type: "text";
  value: string;
}

/** An element node of that tree. */
export interface HastElement {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
}

/** Any node of that tree: text and elements, which the rehype plugins rewrite, and the rest. */
export type HastNode = HastText | HastElement | { type: string; children?: HastNode[] };

export const isHastText = (node: HastNode): node is HastText =>
  node.type === "text" && "value" in node && typeof node.value === "string";

export const isHastElement = (node: HastNode): node is HastElement =>
  node.type === "element" && "tagName" in node && typeof node.tagName === "string";

/** A node's text: its own, or its children's run together. */
export const hastTextOf = (node: HastNode): string => {
  if (isHastText(node)) return node.value;
  return "children" in node && node.children !== undefined
    ? node.children.map(hastTextOf).join("")
    : "";
};
