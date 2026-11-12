// Builds the web app as a package another app mounts: `dist-embed`, with its entry, stylesheet,
// types and a manifest. See docs/EMBEDDED_WEB_APP.md.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    'import type { MountGram, ShellLinkComponent, ShellThreadComponent, UseShellLocation } from "./types/embed/contract.js";',
    "",
    'export type * from "./types/embed/contract.js";',
    "/** Mounts Gram's web app, whole, in `options.element`. */",
    "export declare const mountGram: MountGram;",
    "/** A link to a path under the app that moves the window without loading the page again. */",
    "export declare const ShellLink: ShellLinkComponent;",
    "/** One thread inside a page of the embedding app's. */",
    "export declare const ShellThread: ShellThreadComponent;",
    "/** Where the window is under the app, and a way to move it. */",
    "export declare const useShellLocation: UseShellLocation;",
    "",
  ].join("\n"),
);
writeFileSync(join(outDir, "gram-web-kit.d.ts"), 'export * from "./types/embed/kit.js";\n');
// The theme's names for an embedding app's own Tailwind build; the values come with the app.
copyFileSync(join(webDir, "src/styles/theme.css"), join(outDir, "theme.css"));

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
