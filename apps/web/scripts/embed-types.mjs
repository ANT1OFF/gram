// The embeddable package's declarations: `gram-web.d.ts`, `gram-web-kit.d.ts` and `types/`. Kept
// apart from the bundle so a test can write them and type-check an app against exactly what ships
// (src/embed/kit-types.test.ts). See docs/EMBEDDED_WEB_APP.md.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(join(webDir, "package.json"));

// Declarations for the two entries. The contract imports nothing of the app; the kit re-exports
// a few of the app's components, whose declarations name only React and the libraries they wrap.
// The compiler writes one for every module those reach, so only the listed ones are kept, with
// the app's `@/` paths made relative, and anything else they turn out to need stops the build.
export const TYPES = [
  "embed/contract",
  "embed/kit",
  "embed/page",
  "components/empty-state",
  "components/hint",
  "components/ui/alert",
  "components/ui/badge",
  "components/ui/button",
  "components/ui/button-group",
  "components/ui/checkbox",
  "components/ui/collapsible",
  "components/ui/input",
  "components/ui/menu",
  "components/ui/meter",
  "components/ui/select",
  "components/ui/skeleton",
  "components/ui/switch",
  "components/ui/tabs",
  "components/ui/tooltip",
  "motion/shimmer",
  "settings/fields",
  "settings/settings-group",
  "shell/titlebar-popover",
  "thread/dialog-shell",
];

/** The libraries a kept declaration may name: they become the package's dependencies. */
export const TYPE_LIBRARIES = ["@base-ui/react", "class-variance-authority"];

/** Writes the package's declarations into `outDir`; throws on what the package doesn't ship. */
export function writeDeclarations(outDir) {
  const emitted = mkdtempSync(join(tmpdir(), "gram-embed-types-"));
  try {
    const tsc = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");
    const result = spawnSync(
      process.execPath,
      [tsc, "--project", "tsconfig.embed.json", "--outDir", emitted],
      { cwd: webDir, encoding: "utf8" },
    );
    if (result.status !== 0)
      throw new Error(`build-embed: types failed\n${result.stdout}${result.stderr}`);
    rmSync(join(outDir, "types"), { recursive: true, force: true });
    for (const name of TYPES) {
      const depth = name.split("/").length - 1;
      const up = depth === 0 ? "./" : "../".repeat(depth);
      const text = readFileSync(join(emitted, `${name}.d.ts`), "utf8").replaceAll(
        /(from |import\()"@\/([^"]+)"/g,
        (_match, lead, path) => `${lead}"${up}${path}.js"`,
      );
      for (const [, specifier] of text.matchAll(/(?:from |import\()"([^"]+)"/g)) {
        const known = specifier.startsWith(".")
          ? TYPES.includes(
              join(dirname(name), specifier).replaceAll("\\", "/").replace(/\.js$/, ""),
            )
          : specifier === "react" ||
            TYPE_LIBRARIES.some((each) => specifier === each || specifier.startsWith(`${each}/`));
        if (!known)
          throw new Error(
            `build-embed: ${name}.d.ts names "${specifier}", which the package doesn't ship`,
          );
      }
      mkdirSync(dirname(join(outDir, "types", `${name}.d.ts`)), { recursive: true });
      writeFileSync(join(outDir, "types", `${name}.d.ts`), text);
    }
  } finally {
    rmSync(emitted, { recursive: true, force: true });
  }
  writeFileSync(
    join(outDir, "gram-web.d.ts"),
    [
      'import type { MountGram, ShellLinkComponent, ShellThreadComponent, ShellThreadPanelComponent, UseShellLocation } from "./types/embed/contract.js";',
      "",
      'export type * from "./types/embed/contract.js";',
      "/** Mounts Gram's web app, whole, in `options.element`. */",
      "export declare const mountGram: MountGram;",
      "/** A link to a path under the app that moves the window without loading the page again. */",
      "export declare const ShellLink: ShellLinkComponent;",
      "/** One thread inside a page of the embedding app's. */",
      "export declare const ShellThread: ShellThreadComponent;",
      "/** One thread's diff, pull request, files and terminal inside a page of the embedding app's. */",
      "export declare const ShellThreadPanel: ShellThreadPanelComponent;",
      "/** Where the window is under the app, and a way to move it. */",
      "export declare const useShellLocation: UseShellLocation;",
      "",
    ].join("\n"),
  );
  writeFileSync(join(outDir, "gram-web-kit.d.ts"), 'export * from "./types/embed/kit.js";\n');
}
