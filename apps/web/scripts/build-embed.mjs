// Builds the web app as a package another app mounts: `dist-embed`, with its entry, stylesheet,
// types and a manifest. See docs/EMBEDDED_WEB_APP.md.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TYPE_LIBRARIES, writeDeclarations } from "./embed-types.mjs";

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
// The light kit, on its own, beside the rest: a page that shows before Gram mounts loads this and
// nothing of the app, so it keeps a budget (bundle-budgets.json, `kitLiteKb`): the entry and every
// file it imports.
run("light kit", binOf("vite", "bin/vite.js"), ["build", "--config", "vite.kit-lite.config.ts"]);
{
  const budget = JSON.parse(readFileSync(join(webDir, "bundle-budgets.json"), "utf8")).kitLiteKb;
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const code = readFileSync(join(outDir, file), "utf8");
    for (const [, specifier] of code.matchAll(/(?:from|import)\s*["'](\.\/[^"']+\.js)["']/g))
      visit(join(dirname(file), specifier).replaceAll("\\", "/"));
  };
  visit("gram-web-kit-lite.js");
  let bytes = 0;
  for (const file of seen) bytes += readFileSync(join(outDir, file)).byteLength;
  const kb = bytes / 1000;
  if (kb > budget) {
    console.error(
      `build-embed: the light kit loads ${kb.toFixed(0)} kB (${seen.size} files), over its ${budget} kB budget in bundle-budgets.json`,
    );
    process.exit(1);
  }
  console.log(`build-embed: the light kit loads ${kb.toFixed(0)} kB of its ${budget} kB budget`);
}

writeDeclarations(outDir);

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
        "./kit-lite": { types: "./gram-web-kit-lite.d.ts", default: "./gram-web-kit-lite.js" },
        "./kit-lite.css": "./gram-web-kit-lite.css",
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
