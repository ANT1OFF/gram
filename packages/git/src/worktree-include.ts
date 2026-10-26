// Copy gitignored-but-needed files (.env etc.) into a new worktree, honouring the repo's
// `.worktreeinclude` (gitignore syntax). Claude Code's native copy only fires when Claude itself
// creates the worktree.

import * as nodePath from "node:path";
import * as Effect from "effect/Effect";
import { copyInside, readInside, realRoot } from "./contained.ts";
import { git } from "./exec.ts";
import type { Proc } from "./proc.ts";

/** Ignored-file listings include `node_modules`; far past the view cap on a real repo. */
const LS_FILES_MAX_BYTES = 256 * 1024 * 1024;

/**
 * The glob alternatives for `.worktreeinclude` content. Blank lines and `#` comments are skipped; a
 * leading `/` anchors to the root. A bare name matches at any depth, as in gitignore.
 */
export const includePatterns = (content: string): Array<string> =>
  content.split("\n").flatMap((raw) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return [];
    const pattern = line.startsWith("/") ? line.slice(1) : line;
    if (pattern === "") return [];
    const anchored = line.startsWith("/") || pattern.includes("/");
    return anchored ? [pattern] : [pattern, `**/${pattern}`];
  });

export const matchesInclude = (patterns: ReadonlyArray<string>, relPath: string): boolean =>
  patterns.some((pattern) => nodePath.posix.matchesGlob(relPath, pattern));

/**
 * Copy files that are BOTH gitignored-untracked AND matched by `.worktreeinclude` from `repoTop` into
 * `worktreeDir`. Returns the count. Never fails creation: per-file errors are skipped. Both ends stay
 * inside their checkout: a source that is a link or resolves outside `repoTop` is skipped, and so is
 * a destination the new branch has routed through a link.
 */
export const copyWorktreeIncludes = (
  repoTop: string,
  worktreeDir: string,
): Effect.Effect<number, never, Proc> =>
  Effect.gen(function* () {
    let from: string;
    let to: string;
    let content: string;
    try {
      from = realRoot(repoTop);
      to = realRoot(worktreeDir);
      content = readInside(from, ".worktreeinclude");
    } catch {
      return 0;
    }
    const patterns = includePatterns(content);
    if (patterns.length === 0) return 0;
    const out = yield* git(
      repoTop,
      ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"],
      { maxOutputBytes: LS_FILES_MAX_BYTES },
    );
    if (out.status !== 0 || out.truncated) return 0;
    let copied = 0;
    for (const rel of out.stdout.split("\0")) {
      if (rel === "" || !matchesInclude(patterns, rel)) continue;
      try {
        copyInside(from, to, rel);
        copied += 1;
      } catch {
        // Skip the file; the worktree is still usable without it.
      }
    }
    return copied;
  }).pipe(Effect.orElseSucceed(() => 0));
