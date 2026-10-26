import type { FsFileName } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  formatMention,
  inOpenFence,
  insertMention,
  mentionPath,
  mentionTrigger,
  rankMentions,
} from "./mention";

const at = (text: string) => mentionTrigger(text, text.length);

const ENTRIES: FsFileName[] = [
  { path: ".github", kind: "dir" },
  { path: ".github/workflows", kind: "dir" },
  { path: ".github/workflows/ci.yml", kind: "file" },
  { path: "README.md", kind: "file" },
  { path: "docs", kind: "dir" },
  { path: "docs/architecture.md", kind: "file" },
  { path: "package.json", kind: "file" },
  { path: "src", kind: "dir" },
  { path: "src/clock.ts", kind: "file" },
  { path: "src/retry.test.ts", kind: "file" },
  { path: "src/retry.ts", kind: "file" },
];

const offered = (query: string) => rankMentions(ENTRIES, query).map(mentionPath);

describe("mentionTrigger", () => {
  it("opens on an @ at the start, after whitespace or after an opening bracket", () => {
    expect(at("@")).toEqual({ start: 0, query: "" });
    expect(at("look at @src/re")).toEqual({ start: 8, query: "src/re" });
    expect(at("see (@docs")).toEqual({ start: 5, query: "docs" });
    expect(at("first line\n@READ")).toEqual({ start: 11, query: "READ" });
  });

  it("stays shut for an email-like a@b, once whitespace follows, and inside a code fence", () => {
    expect(at("mail me@organization.example.invalid")).toBeUndefined();
    expect(at("npm i left-pad@1")).toBeUndefined();
    expect(at("@src/retry.ts and")).toBeUndefined();
    expect(at("```ts\nconst a = @src")).toBeUndefined();
    expect(at("```ts\ncode\n```\n@src")).toEqual({ start: 15, query: "src" });
  });

  it("reads only up to the caret", () => {
    expect(mentionTrigger("@src/retry.ts is flaky", 4)).toEqual({ start: 0, query: "src" });
    expect(mentionTrigger("fix @src now", 12)).toBeUndefined();
  });
});

describe("rankMentions", () => {
  it("offers the top level, folders first, when nothing is typed", () => {
    expect(offered("")).toEqual([".github/", "docs/", "src/", "package.json", "README.md"]);
  });

  it("offers a folder's children once its path ends in a slash", () => {
    expect(offered("src/")).toEqual(["src/clock.ts", "src/retry.test.ts", "src/retry.ts"]);
    expect(offered(".github/")).toEqual([".github/workflows/"]);
  });

  it("matches fuzzily, putting names that start with the query and shorter paths first", () => {
    expect(offered("retry")).toEqual(["src/retry.ts", "src/retry.test.ts"]);
    expect(offered("sr")[0]).toBe("src/");
    expect(offered("rty")).toContain("src/retry.ts");
    expect(offered("CI")[0]).toBe(".github/workflows/ci.yml");
    expect(offered("zzz")).toEqual([]);
  });

  it("caps what it offers", () => {
    expect(rankMentions(ENTRIES, "", 2)).toHaveLength(2);
  });
});

describe("insertMention", () => {
  const file: FsFileName = { path: "src/retry.ts", kind: "file" };
  const dir: FsFileName = { path: "src", kind: "dir" };

  it("replaces the typed mention with the file and a space, and puts the caret after it", () => {
    const text = "look at @ret";
    expect(insertMention(text, at(text)!, text.length, file)).toEqual({
      text: "look at @src/retry.ts ",
      caret: 22,
    });
  });

  it("keeps a folder open for typing into, without a space", () => {
    const text = "@sr";
    expect(insertMention(text, at(text)!, 3, dir)).toEqual({ text: "@src/", caret: 5 });
  });

  it("keeps the text after the caret and doesn't double a space", () => {
    const text = "@ret is flaky";
    expect(insertMention(text, mentionTrigger(text, 4)!, 4, file)).toEqual({
      text: "@src/retry.ts is flaky",
      caret: 14,
    });
  });

  it("quotes a path with whitespace", () => {
    expect(formatMention("docs/design notes.md")).toBe('@"docs/design notes.md"');
    const text = "@des";
    const spaced: FsFileName = { path: "my docs", kind: "dir" };
    expect(insertMention(text, at(text)!, 4, spaced)).toEqual({
      text: '@"my docs/" ',
      caret: 12,
    });
  });
});

describe("inOpenFence", () => {
  it("opens on backticks or tildes and closes on a bare run of the same", () => {
    expect(inOpenFence("```ts\ncode")).toBe(true);
    expect(inOpenFence("~~~\ncode")).toBe(true);
    expect(inOpenFence("```ts\ncode\n```\n")).toBe(false);
    expect(inOpenFence("  ~~~sh\nls\n  ~~~")).toBe(false);
  });

  it("needs a closer at least as long as the opener, of the same character", () => {
    expect(inOpenFence("````md\n```ts\ncode\n```\n")).toBe(true);
    expect(inOpenFence("````md\n```ts\ncode\n```\n````")).toBe(false);
    expect(inOpenFence("```\n~~~\n")).toBe(true);
    expect(inOpenFence("~~~\n```\n~~~~")).toBe(false);
  });

  it("reads a run indented four columns as code, not as a fence", () => {
    expect(inOpenFence("```\ncode\n    ```")).toBe(true);
    expect(inOpenFence("```\ncode\n\t```")).toBe(true);
    expect(inOpenFence("    ```\ncode")).toBe(false);
    expect(inOpenFence("   ```\ncode\n   ```")).toBe(false);
  });

  it("finds a fence inside a block quote or a list item", () => {
    expect(inOpenFence("> ```ts\n> code")).toBe(true);
    expect(inOpenFence("> ```ts\n> code\n> ```")).toBe(false);
    expect(inOpenFence("- ```ts\n  code")).toBe(true);
    expect(inOpenFence("- ```ts\n  code\n  ```")).toBe(false);
    // Under `10. ` the content column is 4, which would be indented code at the left margin.
    expect(inOpenFence("10. step\n    ```sh\n    ls")).toBe(true);
    expect(inOpenFence("10. step\n    ```sh\n    ls\n    ```")).toBe(false);
    expect(inOpenFence("> - ```\n>   code")).toBe(true);
  });

  it("ends a fence with its container, so a run outside it opens a new one", () => {
    expect(inOpenFence("> ```ts\n> code\n```")).toBe(true);
    expect(inOpenFence("> ```ts\n> code\n```\nmore\n```")).toBe(false);
    expect(inOpenFence("> ```ts\n> code\nback at the root")).toBe(false);
    expect(inOpenFence("10. step\n    ```sh\n    ls\n```")).toBe(true);
    // A blank line inside a listed fence is still inside it.
    expect(inOpenFence("- ```ts\n\n  code")).toBe(true);
  });

  it("reads a quote marker inside a fence as content, not as a container", () => {
    expect(inOpenFence("```md\n> ```\n")).toBe(true);
    expect(inOpenFence("> ```md\n> > ```\n> still in")).toBe(true);
    expect(inOpenFence("> ```md\n> > ```\n> ```")).toBe(false);
  });

  it("forgets a list's margin once a line starts left of it", () => {
    expect(inOpenFence("10. step\n\nback out\n    ```")).toBe(false);
  });

  it("leaves thematic breaks and bullets of plain text alone", () => {
    expect(inOpenFence("- one\n- two\n\n---\n")).toBe(false);
  });

  it("doesn't take a fence with text after it for a closer, or inline code for an opener", () => {
    expect(inOpenFence("```\ncode\n```ts")).toBe(true);
    expect(inOpenFence("```not a fence``` and on")).toBe(false);
  });
});
