import { describe, expect, it } from "@effect/vitest";
import { MEMORY_INDEX_TEMPLATE } from "./memory.ts";
import {
  frontMatterOf,
  lintMemory,
  MEMORY_INDEX_TARGET_BYTES,
  memoryLinks,
  seriousLintProblems,
} from "./memory-lint.ts";

const note = (name: string, description: string, body = "") =>
  `---\nname: ${name}\ndescription: ${description}\ntype: project\n---\n\n${body}\n`;

const kinds = (files: ReadonlyArray<{ path: string; content: string }>) =>
  lintMemory(files).map((problem) => `${problem.kind} ${problem.path}`);

describe("memoryLinks", () => {
  it("finds links outside code, once each, without an alias or heading", () => {
    expect(
      memoryLinks(
        "See [[deploy]] and [[deploy|how we ship]], [[repos/api#Tests]].\n`[[name]]` is an example.\n```\n[[fenced]]\n```\n",
      ),
    ).toEqual(["deploy", "repos/api"]);
  });
});

describe("frontMatterOf", () => {
  it("reads flat fields and leaves a note without front matter empty", () => {
    expect(frontMatterOf(note("ci", "How CI runs"))).toMatchObject({
      name: "ci",
      description: "How CI runs",
    });
    expect(frontMatterOf("# Just text\n")).toEqual({});
  });
});

describe("lintMemory", () => {
  it("finds nothing wrong with the starter index", () => {
    expect(lintMemory([{ path: "MEMORY.md", content: MEMORY_INDEX_TEMPLATE }])).toEqual([]);
  });

  it("resolves a link by path, file name or front matter name, case and separators aside", () => {
    const files = [
      {
        path: "MEMORY.md",
        content:
          "# Memory index\n\n- [[deploy-order]]: deploy\n- [[repos/api]]: api\n- [[Release_Train]]: trains\n",
      },
      { path: "deploy-order.md", content: note("deploy-order", "Which service deploys first") },
      { path: "repos/api.md", content: note("api", "Working in the api repo") },
      { path: "trains.md", content: note("release-train", "How releases are batched") },
    ];
    expect(kinds(files)).toEqual([]);
  });

  it("reports dangling links, duplicate subjects, unindexed notes and an oversized index", () => {
    const files = [
      {
        path: "MEMORY.md",
        content: `# Memory index\n\n- [[ci]]: CI\n- [[gone]]: was removed\n${"- filler line\n".repeat(400)}`,
      },
      { path: "ci.md", content: note("ci", "How CI runs and what flakes", "See [[flakes]].") },
      { path: "ci-notes.md", content: note("ci", "Notes on CI") },
      { path: "runner.md", content: note("runner", "How CI runs and what flakes") },
      { path: "loose.md", content: "No front matter here.\n" },
    ];
    const found = kinds(files);
    expect(found).toEqual(
      expect.arrayContaining([
        "dangling_link MEMORY.md",
        "dangling_link ci.md",
        "duplicate_note ci-notes.md",
        "duplicate_description ci.md",
        "index_over_target MEMORY.md",
        "not_in_index runner.md",
        "not_in_index loose.md",
        "no_description loose.md",
      ]),
    );
    expect(found).not.toContain("not_in_index ci.md");
    // Serious problems come first, and only they send a dream back.
    const serious = seriousLintProblems(lintMemory(files))!;
    expect(serious.map((problem) => problem.kind)).not.toContain("not_in_index");
    expect(found.slice(0, serious.length).every((line) => !line.startsWith("not_in_index"))).toBe(
      true,
    );
    expect(MEMORY_INDEX_TARGET_BYTES).toBe(4096);
  });

  it("has nothing serious to send back for a tidy set", () => {
    expect(
      seriousLintProblems(
        lintMemory([
          { path: "MEMORY.md", content: "# Memory index\n\n- [[a]]: a\n" },
          { path: "a.md", content: note("a", "The one note about a") },
        ]),
      ),
    ).toBeUndefined();
  });
});
