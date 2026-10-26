// Regenerates `src/codex/protocol` from the installed CLI's `codex app-server generate-ts
// --experimental` (plan mode is experimental). The CLI must be the version pinned in
// `src/codex/version.ts`. Imports get explicit `.ts` extensions so the bindings type-check under
// `nodenext`.
//
// `--qualify` takes whatever CLI is installed: the agent catalog's qualification generates a
// candidate's bindings over the committed ones and typechecks the adapter against them, in a CI
// checkout that is thrown away. Never commit what it generates.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const out = join(root, "src/codex/protocol");
const pinned = /CODEX_CLI_VERSION = "([^"]+)"/.exec(
  readFileSync(join(root, "src/codex/version.ts"), "utf8"),
)?.[1];
const installed = execFileSync("codex", ["--version"], { encoding: "utf8" })
  .trim()
  .split(" ")
  .at(-1);
const qualify = process.argv.includes("--qualify");
if (installed !== pinned && !qualify) {
  console.error(`codex ${installed} is installed, but src/codex/version.ts pins ${pinned}.`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
execFileSync("codex", ["app-server", "generate-ts", "--experimental", "--out", out], {
  stdio: "inherit",
});

const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });

for (const file of files(out)) {
  const source = readFileSync(file, "utf8");
  const rewritten = source.replace(/from "(\.{1,2}\/[^"]+)"/g, (match, specifier) => {
    if (specifier.endsWith(".ts")) return match;
    const target = resolve(dirname(file), specifier);
    if (existsSync(`${target}.ts`)) return `from "${specifier}.ts"`;
    if (existsSync(join(target, "index.ts"))) return `from "${specifier}/index.ts"`;
    throw new Error(`${file}: can't resolve ${specifier}`);
  });
  if (rewritten !== source) writeFileSync(file, rewritten);
}
console.log(`Generated ${files(out).length} files for codex ${installed}.`);
