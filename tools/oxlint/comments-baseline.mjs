// Counts `gram/no-comment`'s refusals per file, for its shrink-only baseline.
//
//   node tools/oxlint/comments-baseline.mjs           lowers the baseline to the source as it is
//   node tools/oxlint/comments-baseline.mjs --check   fails when an entry is above its file's count
//
// Lowering never raises an entry or adds a file: a new comment is cleared, not listed.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BASELINE_PATH } from "./no-comment.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");

/** How many comments the rule refuses in each file of `apps` and `packages`, ignoring the baseline. */
export const countComments = () => {
  const result = spawnSync(
    process.execPath,
    [join(REPO, "node_modules/oxlint/bin/oxlint"), "--format", "json", "apps", "packages"],
    {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env, GRAM_COUNT_COMMENTS: "1" },
      maxBuffer: 256 * 1024 * 1024,
      timeout: 300_000,
    },
  );
  if (result.error) throw result.error;
  const counts = {};
  for (const { code, filename } of JSON.parse(result.stdout).diagnostics)
    if (code === "gram(no-comment)") counts[filename] = (counts[filename] ?? 0) + 1;
  return counts;
};

export const readBaseline = () => JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

const write = (entries) =>
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(Object.fromEntries(entries.toSorted(([a], [b]) => a.localeCompare(b))), null, 2)}\n`,
  );

const main = () => {
  const counts = countComments();
  const baseline = readBaseline();
  if (process.argv.includes("--seed")) {
    write(Object.entries(counts));
    return 0;
  }
  const lowered = Object.entries(baseline).flatMap(([file, allowed]) => {
    const count = Math.min(allowed, counts[file] ?? 0);
    return count > 0 ? [[file, count]] : [];
  });
  const stale = Object.entries(baseline).filter(([file, allowed]) => (counts[file] ?? 0) < allowed);
  if (process.argv.includes("--check")) {
    for (const [file, allowed] of stale)
      console.error(`${file}: ${counts[file] ?? 0} comments, the baseline says ${allowed}`);
    if (stale.length > 0)
      console.error(
        "Fewer comments than listed (good): run node tools/oxlint/comments-baseline.mjs",
      );
    return stale.length > 0 ? 1 : 0;
  }
  write(lowered);
  console.log(`Lowered ${stale.length} entries in tools/oxlint/comments-baseline.json.`);
  return 0;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main());
