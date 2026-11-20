// Writes what `gram/no-comment` compares against, before oxlint runs: each product file changed
// since the merge base with GRAM_COMMENTS_BASE (default origin/main), with its text there (null
// when new). The rule cannot ask git itself: a child process forked from oxlint's worker fails.
//
//   node tools/oxlint/comments-base.mjs   run by `bun run lint` ahead of oxlint
//
// CI checks out the pull request's merge commit with its parent, and sets the base to HEAD^1.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { COMMENTS_BASE_PATH, REPO } from "./no-comment.mjs";

const git = (...args) => {
  const run = spawnSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28 });
  return run.status === 0 ? run.stdout : undefined;
};
const lines = (out) => (out ?? "").split("\n").filter(Boolean);

const main = () => {
  const base = process.env.GRAM_COMMENTS_BASE || "origin/main";
  const mergeBase = git("merge-base", base, "HEAD")?.trim();
  mkdirSync(dirname(COMMENTS_BASE_PATH), { recursive: true });
  if (!mergeBase) {
    writeFileSync(COMMENTS_BASE_PATH, JSON.stringify({ base, files: null }));
    if (process.env.CI) {
      console.error(
        `gram/no-comment: ${base} is not in this checkout. Fetch the base (CI: fetch-depth 2 and GRAM_COMMENTS_BASE=HEAD^1).`,
      );
      return 1;
    }
    console.warn(`gram/no-comment: ${base} is not in this checkout, so no comments are checked.`);
    return 0;
  }
  const files = {};
  for (const line of lines(
    git("diff", "--name-status", "-M", mergeBase, "--", "apps", "packages"),
  )) {
    const [status, from, to] = line.split("\t");
    if (status.startsWith("D")) continue;
    files[to ?? from] = status.startsWith("A")
      ? null
      : (git("show", `${mergeBase}:${from}`) ?? null);
  }
  for (const path of lines(
    git("ls-files", "--others", "--exclude-standard", "--", "apps", "packages"),
  ))
    files[path] = null;
  writeFileSync(COMMENTS_BASE_PATH, JSON.stringify({ base, files }));
  return 0;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main());
