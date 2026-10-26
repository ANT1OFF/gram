import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));

/**
 * A sandboxed preload can load nothing but `electron`, so the entries a preload imports bring in
 * types from packages, and values only from files of their own that keep to the same rule.
 * `/core`, `/electron` and `/modules/*` are main-only: they read files, run commands
 * or import `electron` itself.
 */
const PRELOAD_ENTRIES = ["channels.ts", "window-arg.ts", "preload.ts"];

const source = (file: string) => readFileSync(join(SRC, file), "utf8");

/** Each `import … from` and `export … from` in `text`, and whether it brings in types only. */
const specifiers = (text: string) =>
  [...text.matchAll(/^(import|export)\s+(type\s+)?[^;]*?\bfrom\s+"([^"]+)";/gms)].map((m) => ({
    typeOnly: m[2] !== undefined,
    from: m[3]!,
  }));

/** Every file `entry` reaches by value, and each value import of a package along the way. */
function reach(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages: string[] = [];
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const { typeOnly, from } of specifiers(source(file))) {
      if (typeOnly) continue;
      // `relative` gives `\` on Windows; the files are named with `/` so one list holds on both.
      if (from.startsWith(".")) {
        visit(relative(SRC, join(SRC, dirname(file), from)).replaceAll("\\", "/"));
      } else packages.push(`${file}: ${from}`);
    }
  };
  visit(entry);
  return { files: [...files].toSorted(), packages };
}

const manifest = JSON.parse(readFileSync(join(SRC, "../package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  exports: Record<string, unknown>;
};

describe("the package's entries and dependencies", () => {
  it.each(PRELOAD_ENTRIES)(
    "%s brings in no package's code, through anything it imports",
    (file) => {
      expect(reach(file).packages).toEqual([]);
    },
  );

  it("keeps each module's preload half preload-safe", () => {
    expect(reach("preload.ts").files).toEqual(
      expect.arrayContaining([
        "modules/connection/preload.ts",
        "modules/fonts/preload.ts",
        "modules/preview/preload.ts",
        "modules/speech/preload.ts",
        "modules/speech/relay.ts",
        "modules/tray/preload.ts",
      ]),
    );
  });

  it("depends on contracts, and on git's bounded runner, and nothing else", () => {
    expect(Object.keys(manifest.dependencies ?? {}).toSorted()).toEqual([
      "@gram/contracts",
      "@gram/git",
      "effect",
    ]);
  });

  it("exports main-only entries and the preload's, and nothing else", () => {
    expect(Object.keys(manifest.exports).toSorted()).toEqual([
      "./channels",
      "./core",
      "./electron",
      "./modules/agent-browser",
      "./modules/connection",
      "./modules/fonts",
      "./modules/ipc",
      "./modules/key-vault",
      "./modules/preview",
      "./modules/speech",
      "./modules/tray",
      "./modules/update",
      "./preload",
      "./speech-process",
      "./speech-process/main",
      "./window-arg",
    ]);
  });
});
