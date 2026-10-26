import { lstat } from "node:fs/promises";

/** Refuse static aliases before writing or cleaning up Gram's native home. */
export const assertOwnedCodexPath = async (path: string, directory = false): Promise<void> => {
  const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (entry === undefined) return;
  if (
    entry.isSymbolicLink() ||
    (directory ? !entry.isDirectory() : !entry.isFile() || entry.nlink !== 1)
  ) {
    throw new Error("Owned Codex path must be an unaliased directory or regular file");
  }
};
