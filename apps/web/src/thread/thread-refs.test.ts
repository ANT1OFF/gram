import { describe, expect, it } from "vitest";

import {
  THREAD_REF_TAG,
  rehypeThreadRefs,
  resolveThreadRef,
  splitThreadLinks,
  threadLinkId,
} from "./thread-refs";

const UUID = "0d4f6b2a-8c1e-4f3a-9b7d-2e5c6a1f8b90";
const titles: Record<string, string> = { [UUID]: "Fix the retry test", "t-plan": "Plan" };
const titleOf = (id: string) => titles[id];

describe("threadLinkId", () => {
  it("reads a bare fragment that could be an id", () => {
    expect(threadLinkId(`#${UUID}`)).toBe(UUID);
    expect(threadLinkId("#t-plan")).toBe("t-plan");
  });

  it("leaves everything else alone", () => {
    expect(threadLinkId(UUID)).toBeUndefined();
    expect(threadLinkId(`/t/${UUID}`)).toBeUndefined();
    expect(threadLinkId(`https://example.com/#${UUID}`)).toBeUndefined();
    expect(threadLinkId("#")).toBeUndefined();
    expect(threadLinkId("#a b")).toBeUndefined();
    expect(threadLinkId("#a/b")).toBeUndefined();
    expect(threadLinkId("#a#b")).toBeUndefined();
    expect(threadLinkId(`#${"a".repeat(129)}`)).toBeUndefined();
  });
});

describe("resolveThreadRef", () => {
  it("links a thread the app knows, under its current title", () => {
    expect(resolveThreadRef(UUID, titleOf, true)).toEqual({
      kind: "thread",
      title: "Fix the retry test",
    });
    expect(resolveThreadRef("t-plan", titleOf, true)).toEqual({ kind: "thread", title: "Plan" });
  });

  it("calls an unknown thread-shaped id gone, once the threads have loaded", () => {
    const closed = "4a9e2c1b-7d3f-4e8a-b6c5-1f0d9e8a7b6c";
    expect(resolveThreadRef(closed, titleOf, true)).toEqual({ kind: "gone" });
    expect(resolveThreadRef(closed.toUpperCase(), titleOf, true)).toEqual({ kind: "gone" });
    expect(resolveThreadRef(closed, titleOf, false)).toEqual({ kind: "none" });
  });

  it("never makes an ordinary anchor a thread link", () => {
    expect(resolveThreadRef("setup", titleOf, true)).toEqual({ kind: "none" });
    expect(resolveThreadRef("t-gone", titleOf, true)).toEqual({ kind: "none" });
    expect(resolveThreadRef("0d4f6b2a-8c1e-4f3a-9b7d", titleOf, true)).toEqual({ kind: "none" });
  });
});

describe("splitThreadLinks", () => {
  it("cuts plain text at its fragment links", () => {
    expect(splitThreadLinks(`See [Fix it](#${UUID}), then [Plan](#t-plan).`)).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", id: UUID, label: "Fix it", raw: `[Fix it](#${UUID})` },
      { kind: "text", text: ", then " },
      { kind: "link", id: "t-plan", label: "Plan", raw: "[Plan](#t-plan)" },
      { kind: "text", text: "." },
    ]);
  });

  it("keeps text without one whole, and ignores other links", () => {
    expect(splitThreadLinks("No links here.")).toEqual([{ kind: "text", text: "No links here." }]);
    expect(splitThreadLinks("[docs](https://example.com/#x) [a](#a b)")).toEqual([
      { kind: "text", text: "[docs](https://example.com/#x) [a](#a b)" },
    ]);
    expect(splitThreadLinks("")).toEqual([]);
  });
});

const link = (href: string, text: string) => ({
  type: "element",
  tagName: "a",
  properties: { href },
  children: [{ type: "text", value: text }],
});

describe("rehypeThreadRefs", () => {
  it("wraps fragment links, keeping the link inside", () => {
    const anchor = link(`#${UUID}`, "Fix it");
    const tree = {
      type: "root",
      children: [{ type: "element", tagName: "p", properties: {}, children: [anchor] }],
    };
    rehypeThreadRefs()(tree);
    expect(tree.children[0]!.children[0]).toEqual({
      type: "element",
      tagName: THREAD_REF_TAG,
      properties: { dataThreadId: UUID, dataLabel: "Fix it" },
      children: [anchor],
    });
  });

  it("leaves other links and links in code alone", () => {
    const external = link("https://example.com/#x", "docs");
    const inCode = link(`#${UUID}`, "code");
    const tree = {
      type: "root",
      children: [external, { type: "element", tagName: "pre", properties: {}, children: [inCode] }],
    };
    rehypeThreadRefs()(tree);
    expect(tree.children[0]).toBe(external);
    expect((tree.children[1] as { children: unknown[] }).children[0]).toBe(inCode);
  });
});
