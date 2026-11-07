import { describe, expect, it } from "vitest";

import { inlineMarks, linkText, shortUrl, stripLines } from "./strip-text";

const PR = "https://github.com/example/gram/pull/142";

describe("inlineMarks", () => {
  it("reads a Markdown link as its text, never its syntax", () => {
    expect(inlineMarks(`Opened [#142](${PR}). Waiting on checks now.`)).toEqual([
      { kind: "text", text: "Opened " },
      { kind: "link", text: "#142", href: PR },
      { kind: "text", text: ". Waiting on checks now." },
    ]);
  });

  it("shortens a bare URL and leaves the sentence's full stop outside it", () => {
    expect(inlineMarks(`See ${PR}.`)).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", text: "github.com/…/pull/142", href: PR },
      { kind: "text", text: "." },
    ]);
  });

  it("marks code, bold with a link inside, and italics", () => {
    expect(inlineMarks(`**[#140](${PR}) merged.** Run \`bun test\`, *then* ship`)).toEqual([
      {
        kind: "strong",
        marks: [
          { kind: "link", text: "#140", href: PR },
          { kind: "text", text: " merged." },
        ],
      },
      { kind: "text", text: " Run " },
      { kind: "code", text: "bun test" },
      { kind: "text", text: ", " },
      { kind: "em", marks: [{ kind: "text", text: "then" }] },
      { kind: "text", text: " ship" },
    ]);
  });

  it("keeps a link that opens nothing safe as plain text", () => {
    expect(inlineMarks("[run](javascript:alert(1))")).toEqual([
      { kind: "text", text: "run" },
      { kind: "text", text: ")" },
    ]);
    expect(inlineMarks("[notes](./docs/notes.md)")).toEqual([{ kind: "text", text: "notes" }]);
  });

  it("leaves a lone asterisk, as in a glob or a product, alone", () => {
    expect(inlineMarks("Matches src/*.ts and 2 * 3")).toEqual([
      { kind: "text", text: "Matches src/*.ts and 2 * 3" },
    ]);
  });
});

describe("linkText", () => {
  it("keeps short text, shortens a URL used as text, and clips long text", () => {
    expect(linkText("#142", PR)).toBe("#142");
    expect(linkText(PR, PR)).toBe("github.com/…/pull/142");
    expect(linkText("a".repeat(50), PR)).toHaveLength(36);
    expect(linkText("a".repeat(50), PR).endsWith("…")).toBe(true);
  });
});

describe("shortUrl", () => {
  it("drops the scheme and www, and keeps a short URL whole", () => {
    expect(shortUrl("https://www.example.com/a/")).toBe("example.com/a");
  });
});

describe("stripLines", () => {
  it("drops block syntax and keeps paragraph breaks", () => {
    const lines = stripLines("## Done\n\n- one\n> quoted\n```ts\nconst x = 1;\n```");
    expect(lines).toEqual([
      [{ kind: "text", text: "Done" }],
      [],
      [{ kind: "text", text: "• one" }],
      [{ kind: "text", text: "quoted" }],
      [{ kind: "text", text: "const x = 1;" }],
    ]);
  });
});
