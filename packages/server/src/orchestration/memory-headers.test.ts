// Worker memory headers, fuzzed: a worker reads a memory file only when it has no header, or a
// closed `---` block that is a flat map of plain scalars with no `private` anywhere. Every unusual
// YAML feature, alone or mixed into otherwise plain headers, must be denied; plain ones allowed.
import { describe, expect, it } from "vitest";
import { workerMayRead } from "./memory.ts";

/** A small seeded PRNG (mulberry32), so a failure names a seed that reproduces it. */
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const KEYS = ["title", "updated", "owner", "status", "repo", "topic"];
const VALUES = ["Plans", "2026-11-07", "3", "true", "null", "'ops'", '"a b"', "1.5"];

/** One feature a plain header never has, as a line or block to splice in. */
const UNUSUAL: ReadonlyArray<(pick: <T>(items: ReadonlyArray<T>) => T) => string> = [
  () => "private: true",
  () => "Private: no",
  () => "# private",
  (pick) => `${pick(KEYS)}: !!str ${pick(VALUES)}`,
  (pick) => `${pick(KEYS)}: !custom ${pick(VALUES)}`,
  (pick) => `${pick(KEYS)}: &anchor ${pick(VALUES)}`,
  () => "alias: *anchor",
  (pick) => `${pick(KEYS)}:\n  nested: ${pick(VALUES)}`,
  (pick) => `${pick(KEYS)}:\n  - ${pick(VALUES)}`,
  (pick) => `${pick(KEYS)}: [a, b]`,
  (pick) => `${pick(KEYS)}: {a: b}`,
  () => "note: |\n  text",
  () => "note: >\n  text",
  () => "<<: {title: x}",
  () => "? complex\n: key",
  () => "!!omap",
  () => "!!set",
  () => "%YAML 1.2",
];

const header = (lines: ReadonlyArray<string>) => `---\n${lines.join("\n")}\n---\nThe body.`;

describe("workerMayRead, by header", () => {
  it("allows no header, an empty one, and a flat map of plain scalars", () => {
    expect(workerMayRead("a.md", "Just a body.")).toBe(true);
    expect(workerMayRead("a.md", "---\n---\nBody.")).toBe(true);
    expect(workerMayRead("a.md", header(["title: Plans", "count: 3", "owner: 'ops'"]))).toBe(true);
  });

  it("denies the reviewer's cases: !!omap, !!set and private nested past eight levels", () => {
    expect(workerMayRead("a.md", header(["!!omap", "- title: x", "- private: true"]))).toBe(false);
    expect(workerMayRead("a.md", header(["!!set", "? private", "? title"]))).toBe(false);
    const deep = Array.from({ length: 12 }, (_, n) => `${"  ".repeat(n)}l${n}:`);
    expect(workerMayRead("a.md", header([...deep, `${"  ".repeat(12)}private: true`]))).toBe(false);
  });

  it("denies every unusual feature, alone or mixed into plain headers (fuzzed, 3,000 headers)", () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const random = prng(seed);
      const pick = <T>(items: ReadonlyArray<T>): T => items[Math.floor(random() * items.length)]!;
      const used = new Set<string>();
      const plain: Array<string> = [];
      for (let n = Math.floor(random() * 4); n > 0; n--) {
        const key = pick(KEYS);
        if (used.has(key)) continue;
        used.add(key);
        plain.push(`${key}: ${pick(VALUES)}`);
      }
      const unusual = Array.from({ length: 1 + Math.floor(random() * 2) }, () =>
        pick(UNUSUAL)(pick),
      );
      const lines = [...plain];
      for (const line of unusual) lines.splice(Math.floor(random() * (lines.length + 1)), 0, line);
      expect(workerMayRead("a.md", header(lines)), `seed ${seed}:\n${header(lines)}`).toBe(false);
      // The same plain lines alone are fine.
      expect(workerMayRead("a.md", header(plain)), `seed ${seed} plain`).toBe(true);
    }
  });

  it("denies headers it can't take as plain: unclosed, TOML, a leading comment, broken YAML", () => {
    for (const text of [
      "---\ntitle: Plans\nBody.",
      "+++\ntitle = 'Plans'\n+++\nBody.",
      "<!-- note -->\nBody.",
      "---\ntitle: [unclosed\n---\nBody.",
      "---\ntitle: a\ntitle: b\n---\nBody.",
      "---\njust a scalar\n---\nBody.",
      "----\nBody.",
    ]) {
      expect(workerMayRead("a.md", text), text).toBe(false);
    }
  });
});
