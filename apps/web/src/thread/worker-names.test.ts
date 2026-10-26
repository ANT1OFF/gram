import type { ThreadId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { rehypeWorkerNames, WORKER_REF_TAG } from "./worker-names";

type Node = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: object;
  children?: Node[];
};

const text = (value: string): Node => ({ type: "text", value });
const element = (tagName: string, children: Node[]): Node => ({
  type: "element",
  tagName,
  properties: {},
  children,
});

const run = (names: { threadId: string; title: string }[], tree: Node) => {
  rehypeWorkerNames(names.map((name) => ({ ...name, threadId: name.threadId as ThreadId })))()(
    tree as never,
  );
  return tree;
};

const refs = (node: Node): [string, unknown][] =>
  (node.children ?? []).flatMap((child) =>
    child.tagName === WORKER_REF_TAG
      ? [[child.children![0]!.value!, (child.properties as { dataThreadId: unknown }).dataThreadId]]
      : refs(child),
  );

describe("worker names in orchestrator messages", () => {
  const names = [
    { threadId: "t-q", title: "Queue worker" },
    { threadId: "t-r", title: "Rate limit" },
  ];

  it("links each whole-word name to its worker", () => {
    const tree = run(
      names,
      element("root", [element("p", [text("Not stuck. Queue worker waits on Rate limit.")])]),
    );
    expect(refs(tree)).toEqual([
      ["Queue worker", "t-q"],
      ["Rate limit", "t-r"],
    ]);
  });

  it("leaves code, links and words that only contain a name alone", () => {
    const tree = run(
      names,
      element("root", [
        element("p", [element("code", [text("Queue worker")]), text(" Queue workers ")]),
        element("a", [text("Rate limit")]),
      ]),
    );
    expect(refs(tree)).toEqual([]);
  });

  it("links neither of two workers that share a title, nor a very short one", () => {
    const tree = run(
      [
        { threadId: "a", title: "Docs" },
        { threadId: "b", title: "Docs" },
        { threadId: "c", title: "UI" },
      ],
      element("root", [element("p", [text("Docs and UI are done.")])]),
    );
    expect(refs(tree)).toEqual([]);
  });
});
