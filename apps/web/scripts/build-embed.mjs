// Builds the web app as a package another app mounts: `dist-embed`, with its entry, stylesheet,
// types and a manifest. See docs/EMBEDDED_WEB_APP.md.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(webDir, "dist-embed");
const require = createRequire(join(webDir, "package.json"));

const run = (label, bin, args) => {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: webDir, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`build-embed: ${label} failed`);
    process.exit(result.status ?? 1);
  }
};

const binOf = (name, file) => join(dirname(require.resolve(`${name}/package.json`)), file);

run("bundle", binOf("vite", "bin/vite.js"), ["build", "--config", "vite.embed.config.ts"]);

// Declarations for the two entries. The contract imports nothing of the app; the kit re-exports
// a few of the app's components, whose declarations name only React and the libraries they wrap.
// The compiler writes one for every module those reach, so only the listed ones are kept, with
// the app's `@/` paths made relative, and anything else they turn out to need stops the build.
const TYPES = [
  "embed/contract",
  "embed/kit",
  "embed/page",
  "components/hint",
  "components/ui/alert",
  "components/ui/badge",
  "components/ui/button",
  "components/ui/button-group",
  "components/ui/collapsible",
  "components/ui/input",
  "components/ui/meter",
  "components/ui/select",
  "components/ui/switch",
  "components/ui/tabs",
  "components/ui/tooltip",
  "settings/fields",
  "settings/settings-group",
  "shell/titlebar-popover",
];
/** The libraries a kept declaration may name: they become the package's dependencies. */
const TYPE_LIBRARIES = ["@base-ui/react", "class-variance-authority"];
const emitted = mkdtempSync(join(tmpdir(), "gram-embed-types-"));
try {
  run("types", binOf("typescript", "bin/tsc"), [
    "--project",
    "tsconfig.embed.json",
    "--outDir",
    emitted,
  ]);
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
        ? TYPES.includes(join(dirname(name), specifier).replaceAll("\\", "/").replace(/\.js$/, ""))
        : specifier === "react" ||
          TYPE_LIBRARIES.some((each) => specifier === each || specifier.startsWith(`${each}/`));
      if (!known) {
        console.error(
          `build-embed: ${name}.d.ts names "${specifier}", which the package doesn't ship`,
        );
        process.exit(1);
      }
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
// The theme's names for an embedding app's own Tailwind build; the values come with the app.
// The variants and utilities of the two Tailwind add-ons the app's classes use go in front, so
// that build can write every class of the package's (docs/EMBEDDED_WEB_APP.md, "One utilities
// layer") without installing the add-ons at the same versions itself.
// tw-animate-css exports its stylesheet under the "style" condition only, which Node's resolver
// does not take, so it is found in the folders a package resolves from.
const styleOf = (name, file) => {
  for (const folder of require.resolve.paths(name) ?? []) {
    const path = join(folder, name, file);
    if (existsSync(path)) return path;
  }
  throw new Error(`build-embed: ${name} is not installed`);
};
const ADD_ONS = [
  ["tw-animate-css", styleOf("tw-animate-css", "dist/tw-animate.css")],
  ["shadcn/tailwind.css", require.resolve("shadcn/tailwind.css")],
];
writeFileSync(
  join(outDir, "theme.css"),
  [
    ...ADD_ONS.map(([name, path]) => `/* ${name} */\n${readFileSync(path, "utf8")}`),
    readFileSync(join(webDir, "src/styles/theme.css"), "utf8"),
  ].join("\n"),
);

// The classes of the package's stylesheet, for that build to write again: exactly the utilities
// the app's own build wrote, by name. Scanning the bundle instead would also find the class names
// inside the libraries it carries, which the app's build never wrote and its screens are not
// drawn with (a markdown renderer's list classes). No class is named here: this file is scanned too.
const utilityClasses = (css) => {
  const start = css.indexOf("@layer utilities{");
  if (start === -1) throw new Error("build-embed: the stylesheet has no utilities layer");
  let depth = 0;
  let end = start;
  for (let at = css.indexOf("{", start); at < css.length; at += 1) {
    if (css[at] === "{") depth += 1;
    else if (css[at] === "}" && (depth -= 1) === 0) {
      end = at;
      break;
    }
  }
  const names = new Set();
  // Selectors only: what stands before each `{`, after the last `{`, `}` or `;`.
  for (const [, selector] of css.slice(start, end).matchAll(/(?:^|[{};])([^{};]*)(?={)/g))
    for (const [, name] of selector.matchAll(
      /\.(-?(?:[a-zA-Z_]|\\[0-9a-f]{1,6} ?|\\.)(?:[\w-]|[^\0-\x7f]|\\[0-9a-f]{1,6} ?|\\.)*)/g,
    ))
      names.add(
        name
          .replace(/\\([0-9a-f]{1,6}) ?/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
          .replace(/\\(.)/g, "$1"),
      );
  return [...names].toSorted();
};
writeFileSync(
  join(outDir, "classes.txt"),
  `${utilityClasses(readFileSync(join(outDir, "gram-web.css"), "utf8")).join("\n")}\n`,
);

// The catalog's exact versions: the app is built and tested against these and no others.
const root = JSON.parse(readFileSync(join(webDir, "../../package.json"), "utf8"));
const catalog = root.workspaces?.catalog ?? root.catalog ?? {};
const peer = (name) => {
  const version = catalog[name];
  if (typeof version !== "string") throw new Error(`build-embed: no catalog version for ${name}`);
  return version;
};
writeFileSync(
  join(outDir, "package.json"),
  `${JSON.stringify(
    {
      name: "@gram/web",
      version: root.version ?? "0.0.0",
      license: "MIT",
      type: "module",
      sideEffects: true,
      exports: {
        ".": { types: "./gram-web.d.ts", default: "./gram-web.js" },
        "./kit": { types: "./gram-web-kit.d.ts", default: "./gram-web-kit.js" },
        "./style.css": "./gram-web.css",
        "./theme.css": "./theme.css",
        "./classes.txt": "./classes.txt",
      },
      // Named by the kit's declarations only: the code is in the bundle.
      dependencies: Object.fromEntries(TYPE_LIBRARIES.map((name) => [name, peer(name)])),
      peerDependencies: {
        react: peer("react"),
        "react-dom": peer("react-dom"),
        "@types/react": peer("@types/react"),
      },
      // The declarations name React's types; an app not written in TypeScript needs none.
      peerDependenciesMeta: { "@types/react": { optional: true } },
    },
    null,
    2,
  )}\n`,
);
console.log(`build-embed: wrote ${outDir}`);
