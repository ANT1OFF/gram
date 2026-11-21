import type { Stats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import type { WorktreeSize } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

const SIZE_BUDGET_MS = 20_000;

const READERS = 16;

const onDisk = (stats: Stats): number =>
  Number.isFinite(stats.blocks) && stats.blocks > 0 ? stats.blocks * 512 : stats.size;

const folderSize = (root: string, budgetMs = SIZE_BUDGET_MS): Effect.Effect<WorktreeSize> =>
  Effect.promise((signal) => walk(root, Date.now() + budgetMs, signal));

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
        try {
          for await (const entry of await opendir(dir)) {
            if (signal.aborted || Date.now() > deadline) return;
            const path = join(dir, entry.name);
            if (entry.isDirectory()) next.push(path);
            const size = await sizeOf(path, linked);
            bytes += size;
          }
        } catch {
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

const SIZE_TTL_MS = 10 * 60_000;

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
