import { describe, expect, it } from "vitest";
import {
  chunkLimits,
  chunkPatch,
  generatedKind,
  MAX_CHUNK_BYTES,
  MAX_CHUNK_HUNKS,
  MAX_CHUNK_LINES,
  MAX_LINE_CHARS,
  MAX_SUMMARY_SECTIONS,
  summarizePatch,
  type ChunkLimits,
  type DiffCursor,
} from "./diff-chunk.ts";

/** Every line of `patch` with the old and new numbers its hunk headers give it. */
const numbered = (patch: string) => {
  const rows: Array<string> = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of patch.split("\n")) {
    const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (head) {
      oldNo = head[2] === "0" ? Number(head[1]) + 1 : Number(head[1]);
      newNo = head[4] === "0" ? Number(head[3]) + 1 : Number(head[3]);
      continue;
    }
    if (line === "") continue;
    if (line.startsWith("+")) rows.push(`+${newNo++} ${line.slice(1)}`);
    else if (line.startsWith("-")) rows.push(`-${oldNo++} ${line.slice(1)}`);
    else if (line.startsWith("\\")) rows.push(line);
    else rows.push(` ${oldNo++}:${newNo++} ${line.slice(1)}`);
  }
  return rows;
};

/** Every chunk from the start, following `next`. */
const pages = (patch: string, limits: ChunkLimits) => {
  const out: Array<ReturnType<typeof chunkPatch>> = [];
  let cursor: DiffCursor | undefined = { hunk: 0, line: 0 };
  while (cursor !== undefined && out.length < 1000) {
    const page = chunkPatch(patch, cursor, limits);
    out.push(page);
    cursor = page.next;
  }
  return out;
};

const hunk = (oldStart: number, newStart: number, body: Array<string>, context = "") => {
  const old = body.filter((l) => !l.startsWith("+") && !l.startsWith("\\")).length;
  const add = body.filter((l) => !l.startsWith("-") && !l.startsWith("\\")).length;
  return [`@@ -${oldStart},${old} +${newStart},${add} @@${context ? ` ${context}` : ""}`, ...body];
};

const PATCH = [
  ...hunk(1, 1, [" a", "-b", "+B", " c"], "first"),
  ...hunk(10, 10, [" j", "+k1", "+k2", "+k3", " l", "-m", "-n", " o"], "second"),
  ...hunk(30, 32, ["-x", "+y", "\\ No newline at end of file"]),
].join("\n");

describe("chunkPatch", () => {
  it("serves whole hunks up to the hunk cap and points at the next", () => {
    const first = chunkPatch(PATCH, undefined, { hunks: 2, lines: 100, bytes: 10_000 });
    expect(first.patch.split("\n").filter((l) => l.startsWith("@@"))).toEqual([
      "@@ -1,3 +1,3 @@ first",
      "@@ -10,5 +10,6 @@ second",
    ]);
    expect(first.next).toEqual({ hunk: 2, line: 0 });
    expect(first).toMatchObject({ totalHunks: 3, additions: 5, deletions: 4, clippedLines: 0 });
    const second = chunkPatch(PATCH, first.next, { hunks: 2, lines: 100, bytes: 10_000 });
    expect(second.next).toBeUndefined();
    expect(second.patch).toBe("@@ -30 +32 @@\n-x\n+y\n\\ No newline at end of file\n");
  });

  it("splits a hunk where the line cap falls, with headers that number the lines as before", () => {
    for (const lines of [1, 2, 3, 5, 7]) {
      const all = pages(PATCH, { hunks: 50, lines, bytes: 1_000_000 });
      expect(all.flatMap((page) => numbered(page.patch))).toEqual(numbered(PATCH));
      for (const page of all) {
        const counted = page.patch.split("\n").filter((l) => /^[ +-]/.test(l)).length;
        expect(counted).toBeLessThanOrEqual(lines);
      }
    }
  });

  it("keeps a no-newline note with its line wherever the cap falls", () => {
    const all = pages(PATCH, { hunks: 50, lines: 1, bytes: 1_000_000 });
    const withNote = all.find((page) => page.patch.includes("\\ No newline"));
    // After `-x` (old line 30), `+y` is new line 32, inserted after old line 30.
    expect(withNote?.patch).toBe("@@ -30,0 +32 @@\n+y\n\\ No newline at end of file\n");
  });

  it("holds the byte cap, letting one line through when the line alone is over it", () => {
    const body = Array.from({ length: 40 }, (_, i) => `+${"x".repeat(100)}${i}`);
    const patch = hunk(0, 1, body).join("\n");
    const all = pages(patch, { hunks: 50, lines: 1000, bytes: 1024 });
    expect(all.length).toBeGreaterThan(4);
    for (const page of all) expect(Buffer.byteLength(page.patch)).toBeLessThanOrEqual(1024 + 120);
    expect(all.flatMap((page) => numbered(page.patch))).toEqual(numbered(patch));
    // A new file's parts: no old lines, so the old side stays `-0,0`.
    expect(all[1]!.patch.split("\n")[0]).toMatch(/^@@ -0,0 \+\d+,\d+ @@$/);
  });

  it("cuts a line past MAX_LINE_CHARS and counts it", () => {
    const patch = hunk(1, 1, [`+${"m".repeat(MAX_LINE_CHARS * 3)}`, " ok"]).join("\n");
    const page = chunkPatch(patch);
    const line = page.patch.split("\n")[1]!;
    expect(line.length).toBe(MAX_LINE_CHARS + 1);
    expect(line.endsWith("…")).toBe(true);
    expect(page.clippedLines).toBe(1);
  });

  it("gives an empty chunk with no next for a cursor past the end", () => {
    for (const cursor of [
      { hunk: 3, line: 0 },
      { hunk: 99, line: 5 },
    ]) {
      const page = chunkPatch(PATCH, cursor);
      expect(page.patch).toBe("");
      expect(page.next).toBeUndefined();
      expect(page.totalHunks).toBe(3);
    }
    // Past the last line of a hunk: the chunk starts at the next hunk.
    expect(chunkPatch(PATCH, { hunk: 0, line: 40 }).patch.startsWith("@@ -10,5")).toBe(true);
  });

  it("serves nothing for a patch with no hunks", () => {
    expect(chunkPatch("")).toEqual({
      patch: "",
      totalHunks: 0,
      additions: 0,
      deletions: 0,
      clippedLines: 0,
    });
  });

  it("clamps the hunks asked for", () => {
    expect(chunkLimits(undefined).hunks).toBe(20);
    expect(chunkLimits(0).hunks).toBe(1);
    expect(chunkLimits(10_000).hunks).toBe(MAX_CHUNK_HUNKS);
    expect(chunkLimits(5)).toEqual({ hunks: 5, lines: MAX_CHUNK_LINES, bytes: MAX_CHUNK_BYTES });
  });
});

describe("generatedKind", () => {
  it("knows lockfiles, minified bundles and source maps by name", () => {
    expect(generatedKind("pnpm-lock.yaml")).toBe("lockfile");
    expect(generatedKind("apps/web/package-lock.json")).toBe("lockfile");
    expect(generatedKind("Cargo.lock")).toBe("lockfile");
    expect(generatedKind("dist/app.min.js")).toBe("minified");
    expect(generatedKind("dist/app.js.map")).toBe("source map");
    expect(generatedKind("src/lock.ts")).toBeUndefined();
  });

  it("reads a changed line only a minifier writes as minified", () => {
    expect(generatedKind("dist/app.js", `@@ -1 +1 @@\n+${"a;".repeat(2000)}`)).toBe("minified");
    expect(generatedKind("src/app.js", "@@ -1 +1 @@\n-a\n+b")).toBeUndefined();
  });
});

describe("summarizePatch", () => {
  it("names a pnpm lockfile's packages, old and new versions together", () => {
    const patch = [
      ...hunk(
        10,
        10,
        [
          "   /zod@4.6.5:",
          "-    resolution: {integrity: sha512-old}",
          "+    resolution: {integrity: sha512-new}",
          "-  /vitest@5.0.0:",
          "+  /vitest@5.1.2:",
          "-    resolution: {integrity: sha512-a}",
          "+    resolution: {integrity: sha512-b}",
        ],
        "packages:",
      ),
      ...hunk(90, 90, ["+  '@scope/pkg@1.0.0':", "+    resolution: {integrity: sha512-c}"]),
    ].join("\n");
    expect(summarizePatch("pnpm-lock.yaml", patch)).toEqual({
      hunks: 2,
      additions: 5,
      deletions: 3,
      sections: [
        { name: "zod", additions: 1, deletions: 1 },
        { name: "vitest", additions: 2, deletions: 2 },
        { name: "@scope/pkg", additions: 2, deletions: 0 },
      ],
      moreSections: 0,
    });
  });

  it("names package-lock.json entries by their node_modules path", () => {
    const patch = hunk(5, 5, [
      '     "node_modules/left-pad": {',
      '-      "version": "1.0.0",',
      '+      "version": "1.1.0",',
      '     "node_modules/@types/node": {',
      '-      "version": "22.0.0",',
      '+      "version": "22.1.0",',
    ]).join("\n");
    expect(summarizePatch("package-lock.json", patch).sections).toEqual([
      { name: "left-pad", additions: 1, deletions: 1 },
      { name: "@types/node", additions: 1, deletions: 1 },
    ]);
  });

  it("falls back on git's hunk context, then the hunk's lines, for other files", () => {
    const patch = [
      ...hunk(1, 1, ["-a", "+b"], "function main()"),
      ...hunk(40, 40, [" x", "+y", " z"]),
    ].join("\n");
    expect(summarizePatch("dist/app.min.js", patch).sections).toEqual([
      { name: "function main()", additions: 1, deletions: 1 },
      { name: "Lines 40–42", additions: 1, deletions: 0 },
    ]);
  });

  it("lists MAX_SUMMARY_SECTIONS sections and counts the rest", () => {
    const body = Array.from({ length: MAX_SUMMARY_SECTIONS + 7 }, (_, i) => `+name = "crate-${i}"`);
    const summary = summarizePatch("Cargo.lock", hunk(0, 1, body).join("\n"));
    expect(summary.sections).toHaveLength(MAX_SUMMARY_SECTIONS);
    expect(summary.moreSections).toBe(7);
    expect(summary.additions).toBe(MAX_SUMMARY_SECTIONS + 7);
  });
});
