import { describe, expect, it } from "vitest";

import * as Schema from "effect/Schema";

import { DOC_TITLE_MAX, DocMeta, docExcerpt, docTitle } from "./docs.ts";

describe("docExcerpt", () => {
  it("keeps the opening prose and drops headings, fences, rules and Markdown marks", () => {
    const markdown = [
      "# Title",
      "",
      "> A **quoted** [link](https://example.invalid) and `code`.",
      "",
      "---",
      "```ts",
      "const hidden = 1;",
      "```",
      "- One item",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
    ].join("\n");
    expect(docExcerpt(markdown)).toBe("A quoted link and code. One item A · B 1 · 2");
  });

  it("reads a hostile line in linear time", () => {
    const started = performance.now();
    for (const line of [
      `|${" \t".repeat(100_000)}x`,
      `${"- ".repeat(100_000)}x`,
      `${"[".repeat(50_000)}`,
    ]) {
      docExcerpt(line);
    }
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("cuts long prose at a word with an ellipsis", () => {
    const excerpt = docExcerpt("word ".repeat(200), 40);
    expect(excerpt.length).toBeLessThanOrEqual(40);
    expect(excerpt.endsWith("word…")).toBe(true);
  });
});

describe("docTitle", () => {
  it("collapses whitespace and caps the length at a word", () => {
    expect(docTitle("  Gap\n\tanalysis  ")).toBe("Gap analysis");
    const long = docTitle("plan ".repeat(60));
    expect(long.length).toBeLessThanOrEqual(DOC_TITLE_MAX);
    expect(long.endsWith("plan…")).toBe(true);
  });
});

const decodes = (value: object) => Schema.decodeUnknownOption(DocMeta)(value)._tag === "Some";

describe("DocMeta", () => {
  const meta = {
    id: "plan-3f9a2c",
    workspaceId: "ws-1",
    title: "Plan",
    authorThreadId: "t-1",
    authorTitle: "Worker",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    updatedBy: "agent",
    revision: 1,
    bytes: 1,
    excerpt: "x",
  };

  it("bounds every field, times to what a Date can hold (review P2, P5)", () => {
    expect(decodes(meta)).toBe(true);
    for (const bad of [
      { updatedAt: 1e100 },
      { createdAt: -1 },
      { updatedAt: 1.5 },
      { revision: 0 },
      { bytes: 256 * 1024 + 1 },
      { title: "t".repeat(DOC_TITLE_MAX + 1) },
      { authorTitle: "w".repeat(17_000) },
      { excerpt: "e".repeat(281) },
      { authorThreadId: "t".repeat(129) },
    ]) {
      expect(decodes({ ...meta, ...bad })).toBe(false);
    }
  });
});
