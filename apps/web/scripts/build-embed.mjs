// Builds the web app as a package another app mounts: `dist-embed`, with its entry, stylesheet,
// types and a manifest. See docs/EMBEDDED_WEB_APP.md.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
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

// The contract imports nothing of the app, so its declarations are the package's types whole.
rmSync(join(outDir, "types"), { recursive: true, force: true });
run("types", binOf("typescript", "bin/tsc"), [
  "--project",
  "tsconfig.embed.json",
  "--outDir",
  join(outDir, "types"),
]);
writeFileSync(
  join(outDir, "gram-web.d.ts"),
  [
    'import type { MountGram, ShellLinkComponent, UseShellLocation } from "./types/contract.js";',
    "",
    'export type * from "./types/contract.js";',
    "/** Mounts Gram's web app, whole, in `options.element`. */",
    "export declare const mountGram: MountGram;",
    "/** A link to a path under the app that moves the window without loading the page again. */",
    "export declare const ShellLink: ShellLinkComponent;",
    "/** Where the window is under the app, and a way to move it. */",
    "export declare const useShellLocation: UseShellLocation;",
    "",
  ].join("\n"),
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
        "./style.css": "./gram-web.css",
      },
      peerDependencies: { react: peer("react"), "react-dom": peer("react-dom") },
    },
    null,
    2,
  )}\n`,
);
console.log(`build-embed: wrote ${outDir}`);
