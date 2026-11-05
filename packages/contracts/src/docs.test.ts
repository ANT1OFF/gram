import { describe, expect, it } from "vitest";

import { DOC_TITLE_MAX, docExcerpt, docTitle } from "./docs.ts";

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
