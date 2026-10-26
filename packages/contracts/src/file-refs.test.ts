import { describe, expect, it } from "vitest";
import { findFileRefs, hrefFileRef, parseFileRef, writtenFileRefs } from "./file-refs.ts";

describe("parseFileRef", () => {
  it("reads a path and every position form", () => {
    expect(parseFileRef("packages/server/src/foo.ts")).toEqual({
      path: "packages/server/src/foo.ts",
    });
    expect(parseFileRef("foo.ts:42")).toEqual({ path: "foo.ts", line: 42 });
    expect(parseFileRef("src/a.ts:42:7")).toEqual({ path: "src/a.ts", line: 42, column: 7 });
    expect(parseFileRef("src/a.ts:10-20")).toEqual({ path: "src/a.ts", line: 10, endLine: 20 });
    expect(parseFileRef("src/a.ts#L10")).toEqual({ path: "src/a.ts", line: 10 });
    expect(parseFileRef("src/a.ts#L10-L20")).toEqual({
      path: "src/a.ts",
      line: 10,
      endLine: 20,
    });
    expect(parseFileRef("src/a.ts#L10-20")).toEqual({ path: "src/a.ts", line: 10, endLine: 20 });
    expect(parseFileRef("src/a.ts#L3C9")).toEqual({ path: "src/a.ts", line: 3, column: 9 });
    expect(parseFileRef("./src/a.ts")).toEqual({ path: "src/a.ts" });
  });

  it("ignores a position that says nothing", () => {
    expect(parseFileRef("src/a.ts:0")).toEqual({ path: "src/a.ts" });
    expect(parseFileRef("src/a.ts:20-10")).toEqual({ path: "src/a.ts", line: 20 });
  });

  it("keeps spaces and parens a code span holds", () => {
    expect(parseFileRef("docs/My Notes.md:3")).toEqual({ path: "docs/My Notes.md", line: 3 });
    expect(parseFileRef("src/routes/(app)/page.tsx")).toEqual({
      path: "src/routes/(app)/page.tsx",
    });
  });

  it("reads Windows separators, and keeps a Windows absolute path as written", () => {
    expect(parseFileRef("src\\lib\\a.ts:12")).toEqual({ path: "src/lib/a.ts", line: 12 });
    expect(parseFileRef("C:\\repo\\src\\a.ts:12")).toEqual({
      path: "C:\\repo\\src\\a.ts",
      line: 12,
    });
    expect(parseFileRef("C:/repo/a.ts")).toEqual({ path: "C:/repo/a.ts" });
  });

  it("refuses what isn't a file path", () => {
    for (const text of [
      "",
      "retry",
      "useState",
      "v1.2",
      "glm-5.3",
      "1.2.3",
      "src/",
      "a/b/",
      "../outside/secret.ts",
      "src/../../etc/passwd",
      "https://organization.example.invalid/a.ts",
      "github.com/owner/repo",
      "docs.example.com:443",
      "owner/repo#12",
      "src/*.ts",
      "a | b.ts",
      "key: value.ts",
      "localhost:3000",
    ]) {
      expect(parseFileRef(text), text).toBeUndefined();
    }
  });

  it("takes a well-known file with no extension", () => {
    expect(parseFileRef("Makefile:12")).toEqual({ path: "Makefile", line: 12 });
    expect(parseFileRef("Unknownfile")).toBeUndefined();
  });
});

const found = (text: string) =>
  findFileRefs(text).map(({ start, end, ref }) => ({ text: text.slice(start, end), ref }));

describe("findFileRefs", () => {
  it("finds paths in prose without their sentence's punctuation", () => {
    expect(found("See src/a.ts, then src/b.ts:12. Done: lib/c.ts#L3-L5!")).toEqual([
      { text: "src/a.ts", ref: { path: "src/a.ts" } },
      { text: "src/b.ts:12", ref: { path: "src/b.ts", line: 12 } },
      { text: "lib/c.ts#L3-L5", ref: { path: "lib/c.ts", line: 3, endLine: 5 } },
    ]);
    expect(found("(in src/a.ts:4)")).toEqual([
      { text: "src/a.ts:4", ref: { path: "src/a.ts", line: 4 } },
    ]);
    expect(found('"src/a.ts" and src/f(1).ts')).toEqual([
      { text: "src/a.ts", ref: { path: "src/a.ts" } },
      { text: "src/f(1).ts", ref: { path: "src/f(1).ts" } },
    ]);
  });

  it("needs a folder or a line for a bare name in prose", () => {
    expect(found("Edit foo.ts:42 and package.json")).toEqual([
      { text: "foo.ts:42", ref: { path: "foo.ts", line: 42 } },
    ]);
    expect(found("Node.js and e.g. this")).toEqual([]);
  });

  it("stops at a space, so a spaced path is only found in code", () => {
    expect(found("docs/My Notes.md")).toEqual([]);
  });

  it("reads Windows separators in prose", () => {
    expect(found("at src\\lib\\a.ts:3.")).toEqual([
      { text: "src\\lib\\a.ts:3", ref: { path: "src/lib/a.ts", line: 3 } },
    ]);
  });

  it("leaves URLs, packages, mail addresses and slashed words alone", () => {
    expect(
      found(
        "https://organization.example.invalid/src/a.ts @effect/vitest me@organization.example.invalid and/or",
      ),
    ).toEqual([]);
    expect(found("a/b, input/output and 0.11.0/ or v0.11.0/notes")).toEqual([]);
    expect(found("file:///tmp/a.md and http://localhost:3000/docs/a.md")).toEqual([]);
  });

  it("finds absolute and home paths anywhere on the machine, with a line", () => {
    expect(found("Wrote /tmp/browser-research/REPORT.md, and ~/notes/todo.md:3.")).toEqual([
      { text: "/tmp/browser-research/REPORT.md", ref: { path: "/tmp/browser-research/REPORT.md" } },
      { text: "~/notes/todo.md:3", ref: { path: "~/notes/todo.md", line: 3 } },
    ]);
  });
});

describe("hrefFileRef", () => {
  it("reads relative, absolute and file:// links with a #L position", () => {
    expect(hrefFileRef("src/a.ts#L12")).toEqual({ path: "src/a.ts", line: 12 });
    expect(hrefFileRef("/repo/My%20Notes.md")).toEqual({ path: "/repo/My Notes.md" });
    expect(hrefFileRef("file:///repo/src/a.ts#L1-L4")).toEqual({
      path: "/repo/src/a.ts",
      line: 1,
      endLine: 4,
    });
    expect(hrefFileRef("file:///C:/repo/a.ts")).toEqual({ path: "C:/repo/a.ts" });
    expect(hrefFileRef("src/a.ts?plain=1#L2")).toEqual({ path: "src/a.ts", line: 2 });
  });

  it("refuses web links and anchors", () => {
    for (const href of ["https://github.com/o/r/blob/main/a.ts", "mailto:a@b.co", "#top", "//x"]) {
      expect(hrefFileRef(href), href).toBeUndefined();
    }
  });
});

/** The paths `writtenFileRefs` reads out of `markdown`. */
const paths = (markdown: string) => writtenFileRefs(markdown).map((ref) => ref.path);

describe("writtenFileRefs", () => {
  it("reads links, code spans and prose as the renderer does, positions dropped", () => {
    expect(
      paths(
        "Wrote `/tmp/r/REPORT.md:12`, [notes](file:///tmp/My%20Notes.md:3), " +
          "[b](</tmp/a b.md#L2>), <file:///tmp/a%26b.md>, **/tmp/bold.md** and ~/notes/todo.md:4.",
      ).toSorted(),
    ).toEqual(
      [
        "/tmp/My Notes.md",
        "/tmp/a b.md",
        "/tmp/a&b.md",
        "/tmp/bold.md",
        "/tmp/r/REPORT.md",
        "~/notes/todo.md",
      ].toSorted(),
    );
    expect(paths("[n](/tmp/%E6%97%A5%E6%9C%AC.md)")).toEqual(["/tmp/日本.md"]);
    expect(paths('[`code` text](/tmp/a.md "title")')).toEqual(["/tmp/a.md"]);
    expect(paths("``/tmp/a`b.md``")).toEqual([]);
    expect(paths("[n](file:///tmp/a%2Emd)")).toEqual(["/tmp/a.md"]);
    expect(paths("<!-- note --> /tmp/after.md")).toEqual(["/tmp/after.md"]);
    expect(paths("~~~\ncode\n~~~  \n/tmp/after.md")).toEqual(["/tmp/after.md"]);
    expect(paths("> ~~~\n> code\n/tmp/after.md")).toEqual(["/tmp/after.md"]);
    expect(paths("~~~\n> ~~~\n~~~\n/tmp/after.md")).toEqual(["/tmp/after.md"]);
    expect(paths("- ```\n  code\n  ```\n- /tmp/after.md")).toEqual(["/tmp/after.md"]);
  });

  it("never reads a fragment, a longer name, code, HTML, an image, a definition or link text", () => {
    for (const markdown of [
      "[b](file:///tmp/My%20Notes.md%23backup)",
      "[b](file:///tmp/My%20Notes.md%2Ebak)",
      "`/tmp/a.md#backup`",
      "/tmp/a.md#backup",
      "file:///tmp/a.md",
      "`[backup](/tmp/a.md)`",
      "``[backup](/tmp/a.md)``",
      "```\n/tmp/a.md\n```",
      "~~~md\n`/tmp/a.md`\n~~~",
      "~~~\n~~~not-a-closer\n/tmp/a.md\n~~~",
      "```\n```js\n/tmp/a.md\n```",
      "> ~~~\n> /tmp/a.md\n> ~~~",
      "~~~\n> ~~~\n/tmp/a.md\n~~~",
      "> ~~~\n> > ~~~\n> /tmp/a.md\n> ~~~",
      ">> ```\n>> /tmp/a.md",
      "- ```\n  /tmp/a.md\n  ```",
      "1. item\n   ```\n   /tmp/a.md\n   ```",
      "```\n/tmp/a.md",
      "    /tmp/a.md",
      "<pre>\n/tmp/a.md\n</pre>",
      "<!-- /tmp/a.md -->",
      "`/tmp/a.md<!--backup-->`",
      "`/tmp/a.md<pre>`",
      "<code>/tmp/a.md</code>",
      "![shot](/tmp/a.md)",
      "[`/tmp/a.md`](https://organization.example.invalid/a)",
      "[/tmp/a.md](https://organization.example.invalid/a)",
      "[n](https://organization.example.invalid/tmp/a.md)",
      "[ref]: /tmp/a.md",
      "\\[x](/tmp/a.md)",
      "x*/tmp/a.md",
    ]) {
      expect(paths(markdown), markdown).not.toContain("/tmp/a.md");
      expect(paths(markdown), markdown).not.toContain("/tmp/My Notes.md");
    }
  });

  it("stays linear on text a message controls", () => {
    for (const hostile of [
      `${"!".repeat(100_000)}x /tmp/a.md`,
      `${")".repeat(100_000)} /tmp/a.md`,
      "[a](".repeat(20_000) + "x".repeat(50_000),
      "`".repeat(5_000) + " ` ".repeat(20_000),
      "[".repeat(50_000),
      "<!--".repeat(20_000),
      "<pre>".repeat(20_000),
      `- ${"\t".repeat(100_000)}x /tmp/a.md`,
      `${"> ".repeat(100_000)}/tmp/a.md`,
      `${"- ".repeat(100_000)}\`\`\``,
    ]) {
      const started = performance.now();
      writtenFileRefs(hostile);
      expect(performance.now() - started, hostile.slice(0, 20)).toBeLessThan(1000);
    }
  });
});
