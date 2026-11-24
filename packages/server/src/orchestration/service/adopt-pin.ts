import { samePath } from "@gram/git";
import { statSync } from "node:fs";
import type { AdoptPin } from "./shape.ts";

/** Whether what an adoption was pinned to when its card was raised still holds. */
export const samePin = (now: AdoptPin, pinned: AdoptPin) =>
  now.project === pinned.project &&
  samePath(now.worktree, pinned.worktree) &&
  now.folder === pinned.folder &&
  now.branch === pinned.branch &&
  Object.entries(now.outside).every(([id, identity]) => pinned.outside[id] === identity);

/** A folder by its device and inode: the same folder, whatever path names it. */
export const folderIdentity = (path: string): string | undefined => {
  try {
    const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
    return stat?.isDirectory() === true ? `${stat.dev}:${stat.ino}` : undefined;
  } catch {
    return undefined;
  }
};
