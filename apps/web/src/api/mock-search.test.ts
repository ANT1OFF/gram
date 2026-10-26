import type { GramUIMessage, Thread } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { searchMessages, searchTerms, snippetAround } from "./mock-search";

const thread = (id: string, title: string) => ({ id, title }) as unknown as Thread;
const message = (id: string, text: string) =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as GramUIMessage;

describe("snippetAround", () => {
  it("clips long text around the matches and offsets the highlights", () => {
    const text = `${"a".repeat(100)}needle${"b".repeat(100)}`;
    const { snippet, highlights } = snippetAround(text, [{ start: 100, end: 106 }], 10);
    expect(snippet).toBe(`…${"a".repeat(10)}needle${"b".repeat(10)}…`);
    const [range] = highlights!;
    expect(snippet.slice(range!.start, range!.end)).toBe("needle");
  });

  it("keeps short text whole on one line", () => {
    expect(snippetAround("find\nme", [{ start: 5, end: 7 }])).toEqual({
      snippet: "find me",
      highlights: [{ start: 5, end: 7 }],
    });
  });
});

describe("searchTerms", () => {
  it("keeps words with letters or digits", () => {
    expect(searchTerms("  Fix ?! the v2 ")).toEqual(["fix", "the", "v2"]);
    expect(searchTerms(" ?! -- ")).toEqual([]);
  });
});

describe("searchMessages", () => {
  const threads = [
    {
      thread: thread("t1", "One"),
      messages: [message("m1", "Fix the Flaky test"), message("m2", "nothing here")],
    },
    { thread: thread("t2", "Two"), messages: [message("m3", "flaky again")] },
    { thread: thread("t3", "Flaky tests in CI"), messages: [] },
  ];

  it("needs every term, prefix-matches the last, and lists title-only hits first", () => {
    const result = searchMessages(threads, "flaky tes", 10);
    expect(result.hits.map((h) => [h.threadId, h.messageId])).toEqual([
      ["t3", undefined],
      ["t1", "m1"],
    ]);
    expect(result.hits[1]!.highlights).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  it("reports truncation", () => {
    const result = searchMessages(threads, "flaky", 1);
    expect(result.hits).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("finds nothing without letters or digits", () => {
    expect(searchMessages(threads, " ?! ", 10)).toEqual({ hits: [], truncated: false });
  });
});
