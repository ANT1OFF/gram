import { errnoCode } from "@gram/contracts";
import * as fs from "node:fs";
import * as nodePath from "node:path";

const MARKER = "gram-untrusted";

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

const HEADS_FILE = "gram-untrusted-heads";

export interface UntrustedHead {
  readonly oid: string;
  readonly branch: string;
}

const OID = /^[0-9a-f]{40,64}$/;

/** Records that `branch` at `oid` is someone else's code. Throws when it can't be written. */
export const recordUntrustedHead = (commonDir: string, head: UntrustedHead): void => {
  if (!OID.test(head.oid)) throw new Error(`${head.oid} isn't a commit id`);
  fs.appendFileSync(nodePath.join(commonDir, HEADS_FILE), `${head.oid} ${head.branch}\n`);
};

/** The heads recorded as someone else's; none when nothing was recorded. Throws when unreadable. */
export const untrustedHeads = (commonDir: string): ReadonlyArray<UntrustedHead> => {
  let text: string;
  try {
    text = fs.readFileSync(nodePath.join(commonDir, HEADS_FILE), "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }
  return text.split("\n").flatMap((line) => {
    const space = line.indexOf(" ");
    const oid = line.slice(0, space);
    const branch = line.slice(space + 1).trim();
    return space > 0 && OID.test(oid) && branch !== "" ? [{ oid, branch }] : [];
  });
};
