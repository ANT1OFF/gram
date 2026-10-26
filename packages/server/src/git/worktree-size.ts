import type { Stats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import type { WorktreeSize } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/** How long one count may walk before it answers with what it has. */
const SIZE_BUDGET_MS = 20_000;

/** Folders read at once, and so the most `lstat` calls in flight. */
const READERS = 16;

/** Allocated blocks where the platform reports them (not Windows), else the file's length. */
const onDisk = (stats: Stats): number =>
  Number.isFinite(stats.blocks) && stats.blocks > 0 ? stats.blocks * 512 : stats.size;

/**
 * Bytes on disk under `root`, the way `du` counts them: symlinks are not followed and a file
 * hard-linked several times inside the tree counts once, so pnpm's links into its own store don't
 * double it. Unreadable entries count as nothing. A walk that passes `budgetMs` stops and answers
 * `partial`, so a huge tree can't hold the request open.
 */
const folderSize = (root: string, budgetMs = SIZE_BUDGET_MS): Effect.Effect<WorktreeSize> =>
  // Plain promises rather than an Effect per entry: a worktree with `node_modules` holds hundreds of
  // thousands of files, and the walk is I/O bound either way.
  Effect.promise((signal) => walk(root, Date.now() + budgetMs, signal));

/** One entry's bytes, 0 for a hard link already counted or an entry removed mid-walk. */
const sizeOf = async (path: string, linked: Set<string>): Promise<number> => {
  try {
    const stats = await lstat(path);
    if (stats.nlink > 1 && !stats.isDirectory()) {
      const key = `${stats.dev}:${stats.ino}`;
      if (linked.has(key)) return 0;
      linked.add(key);
    }
    return onDisk(stats);
  } catch {
    // Removed since its folder was listed: it counts as nothing.
    return 0;
  }
};

const walk = async (root: string, deadline: number, signal: AbortSignal): Promise<WorktreeSize> => {
  const linked = new Set<string>();
  let bytes = 0;
  let level = [root];
  while (level.length > 0) {
    const next: string[] = [];
    let cursor = 0;
    const reader = async () => {
      for (let dir = level[cursor++]; dir !== undefined; dir = level[cursor++]) {
        if (signal.aborted || Date.now() > deadline) return;
        // Streamed and one entry at a time, so a folder of a million files holds neither a million
        // pending calls nor the walk past its deadline.
        try {
          for await (const entry of await opendir(dir)) {
            if (signal.aborted || Date.now() > deadline) return;
            const path = join(dir, entry.name);
            if (entry.isDirectory()) next.push(path);
            // Awaited first: `bytes += await …` would read the total before the wait and drop what
            // the other readers added meanwhile.
            const size = await sizeOf(path, linked);
            bytes += size;
          }
        } catch {
          // Gone or unreadable since it was listed: it frees nothing we could count.
          continue;
        }
      }
    };
    await Promise.all(Array.from({ length: READERS }, reader));
    if (signal.aborted || Date.now() > deadline) return { bytes, partial: true };
    level = next;
  }
  return { bytes, partial: false };
};

/** How long a count is reused: a listing of many worktrees asks for each again on every visit. */
const SIZE_TTL_MS = 10 * 60_000;

/** Counts run at once across the app, so a page of a hundred worktrees doesn't walk them all. */
const walks = Semaphore.makeUnsafe(3);

const sizes = new Map<string, { readonly at: number; readonly size: WorktreeSize }>();

/**
 * `folderSize`, one of three at a time and reused for ten minutes. A count that stopped at its
 * bound isn't kept, so the next ask counts again.
 */
export const cachedFolderSize = (
  root: string,
  budgetMs = SIZE_BUDGET_MS,
): Effect.Effect<WorktreeSize> =>
  Effect.gen(function* () {
    const kept = sizes.get(root);
    if (kept !== undefined && Date.now() - kept.at < SIZE_TTL_MS) return kept.size;
    const size = yield* walks.withPermits(1)(folderSize(root, budgetMs));
    if (!size.partial) sizes.set(root, { at: Date.now(), size });
    return size;
  });

/** Drops a removed folder's count, so a worktree restored there is counted afresh. */
export const forgetFolderSize = (root: string): void => {
  sizes.delete(root);
};
