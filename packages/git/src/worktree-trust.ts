// Whether a worktree holds someone else's tree: a pull request's head from another repository.
// Recorded in the worktree's own git dir, which the checked-out tree can't write or ship, so every
// later step (seeding rules, copying `.worktreeinclude` files, a restore, a reopen) can ask.

import * as fs from "node:fs";
import * as nodePath from "node:path";

const MARKER = "gram-untrusted";

/**
 * The worktree's own git dir, from the `gitdir:` line of its `.git` file; `undefined` for a main
 * checkout (whose `.git` is a folder), a missing or linked `.git`, or one that can't be read.
 */
const worktreeGitDir = (worktreeDir: string): string | undefined => {
  try {
    const dotGit = nodePath.join(worktreeDir, ".git");
    if (!fs.lstatSync(dotGit).isFile()) return undefined;
    const line = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, "utf8"))?.[1];
    if (line === undefined || line === "") return undefined;
    const dir = nodePath.resolve(worktreeDir, line);
    return fs.statSync(dir).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
};

/** Records `worktreeDir` as untrusted. Throws when it isn't a linked worktree it can record. */
export const markUntrustedWorktree = (worktreeDir: string): void => {
  const gitDir = worktreeGitDir(worktreeDir);
  if (gitDir === undefined) throw new Error(`${worktreeDir} isn't a linked worktree`);
  fs.writeFileSync(nodePath.join(gitDir, MARKER), "");
};

/** Whether `worktreeDir` was recorded as untrusted (`markUntrustedWorktree`). */
export const isUntrustedWorktree = (worktreeDir: string): boolean => {
  const gitDir = worktreeGitDir(worktreeDir);
  return gitDir !== undefined && fs.existsSync(nodePath.join(gitDir, MARKER));
};
