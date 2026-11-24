// The light kit's budget (bundle-budgets.json, `kitLiteKb`): a page that shows before Gram mounts
// loads the kit and every file it imports, and nothing of the app. `build-embed.mjs` checks it on
// the package it builds; run on its own, this builds the light kit alone into a scratch folder and
// checks that, in seconds, so `bun run check` catches a change that pulls the app into the kit.
//
//   bun run --filter @gram/web check:kit-lite
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const webDir = fileURLToPath(new URL("..", import.meta.url));

/**
 * The kB the light kit in `outDir` loads, with the budget, or the error that says by how much it
 * is over. Static and dynamic imports alike count: a part loaded on demand is loaded too.
 */
export const kitLiteBudget = (outDir) => {
  const budget = JSON.parse(readFileSync(join(webDir, "bundle-budgets.json"), "utf8")).kitLiteKb;
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const code = readFileSync(join(outDir, file), "utf8");
    for (const [, specifier] of code.matchAll(
      /(?:from|import)\s*\(?\s*["'](\.\.?\/[^"']+\.js)["']/g,
    ))
      visit(join(dirname(file), specifier).replaceAll("\\", "/"));
  };
  visit("gram-web-kit-lite.js");
  let bytes = 0;
  for (const file of seen) bytes += readFileSync(join(outDir, file)).byteLength;
  const kb = bytes / 1000;
  return kb > budget
    ? {
        ok: false,
        message: `the light kit loads ${kb.toFixed(0)} kB (${seen.size} files), over its ${budget} kB budget in bundle-budgets.json. Something it imports pulled in more of the app or of @gram/contracts: keep the kit's files to their own small helpers.`,
      }
    : { ok: true, message: `the light kit loads ${kb.toFixed(0)} kB of its ${budget} kB budget` };
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const outDir = mkdtempSync(join(tmpdir(), "gram-kit-lite-"));
  try {
    const vite = join(
      dirname(createRequire(join(webDir, "package.json")).resolve("vite/package.json")),
      "bin/vite.js",
    );
    const built = spawnSync(
      process.execPath,
      [
        vite,
        "build",
        "--config",
        "vite.kit-lite.config.ts",
        "--outDir",
        outDir,
        "--logLevel",
        "warn",
      ],
      { cwd: webDir, stdio: "inherit" },
    );
    if (built.status !== 0) {
      console.error("check:kit-lite: the light kit's build failed");
      process.exit(built.status ?? 1);
    }
    const result = kitLiteBudget(outDir);
    (result.ok ? console.log : console.error)(`check:kit-lite: ${result.message}`);
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
