import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The light kit's stylesheet writes only the classes of the files it names (`@source` in
// kit-lite.css). A control that comes to import a new file with classes of its own would lose
// them on a light page and nothing else would say so: this follows the light kit's imports and
// asks that every file it reaches that can carry classes is named.

const src = fileURLToPath(new URL("..", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));

const resolveLocal = (from: string, specifier: string): string | undefined => {
  const base = specifier.startsWith("@/")
    ? join(src, specifier.slice(2))
    : specifier.startsWith(".")
      ? join(dirname(from), specifier)
      : undefined;
  if (base === undefined) return undefined;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")])
    if (existsSync(candidate) && !candidate.endsWith("/")) {
      try {
        readFileSync(candidate);
        return candidate;
      } catch {
        // A folder: try the next.
      }
    }
  return undefined;
};

/** Every local module the light kit reaches by its static imports, type-only ones left out. */
function reached(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const code = readFileSync(file, "utf8");
    for (const [, kind, specifier] of code.matchAll(
      /(?:^|\n)\s*(import|export)\s+(?!type\s)[^;]*?from\s+"([^"]+)"/g,
    )) {
      void kind;
      const next = resolveLocal(file, specifier!);
      if (next !== undefined) visit(next);
    }
  };
  visit(entry);
  return seen;
}

/** A Tailwind class among a module's strings: words such a module's classes always have. */
const CLASSY =
  /["'`][^"'`\n]*(?<![-\w])(?:flex|grid|text-|bg-|border|rounded|p[xy]?-\d|gap-|size-)/;

/** A module's code without its comments, which name classes without drawing any. */
const code = (file: string) =>
  readFileSync(file, "utf8")
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/\/\/.*$/gm, "");

describe("the light kit's stylesheet", () => {
  it("names every file the light kit reaches that has classes", () => {
    const css = readFileSync(join(here, "kit-lite.css"), "utf8");
    const named = new Set(
      [...css.matchAll(/@source\s+"([^"]+)"/g)].map(([, path]) => join(here, path!)),
    );
    const files = [...reached(join(here, "kit-lite.ts"))].filter(
      (file) => file.endsWith(".tsx") || CLASSY.test(code(file)),
    );
    expect(files.length).toBeGreaterThan(5);
    const missing = files.filter((file) => !named.has(file)).map((file) => relative(src, file));
    expect(missing).toEqual([]);
  });
});
