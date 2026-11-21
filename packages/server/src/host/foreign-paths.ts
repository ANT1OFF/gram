import { type Checkout, isLocalHost, type Thread } from "@gram/contracts";
import { isInside, keepPathsHere, noteForeignPath, tryRealPathSync } from "@gram/git";
import { isAbsolute, resolve, win32 } from "node:path";

/** A path as compared here: case folded where the volumes usually ignore case. */
const folded = (path: string): string =>
  process.platform === "darwin" || process.platform === "win32" ? path.toLowerCase() : path;

/** This server's own folders (`keepFoldersHere`), as given and by their real paths, folded. */
const ownFolders = new Set<string>();

/** Forgets every `keepFoldersHere`, for tests. */
export const forgetOwnFoldersForTest = (): void => ownFolders.clear();

/**
 * Keeps `paths` (the server's data folder, the folder it runs in) this machine's: a checkout a
 * host records at one of them, above one or below one, never routes there or marks it as another
 * machine's. A relative path is taken against the working directory.
 */
export const keepFoldersHere = (paths: ReadonlyArray<string>): void => {
  keepPathsHere(paths);
  for (const path of paths) {
    const resolved = resolve(path);
    for (const form of [resolved, tryRealPathSync(resolved)])
      if (form !== undefined) ownFolders.add(folded(form));
  }
};

/**
 * Whether a host's recorded folder may be taken as that machine's: one that is, holds or lies under
 * a folder of this server's (`keepFoldersHere`) may not, and neither may one that holds or lies
 * under one of `here` (this machine's checkouts). The very path of one of `here` may: two machines
 * can hold the same path, which then names both.
 */
export const claimableByHost = (path: string, here: Iterable<string> = []): boolean => {
  // A path from a machine of another platform can't hold one of this server's folders.
  if (!isAbsolute(path)) return win32.isAbsolute(path);
  const at = folded(resolve(path));
  for (const own of ownFolders) if (isInside(at, own) || isInside(own, at)) return false;
  for (const mine of here) {
    if (!isAbsolute(mine)) continue;
    const local = folded(resolve(mine));
    if (at !== local && (isInside(at, local) || isInside(local, at))) return false;
  }
  return true;
};

/** Marks one checkout on another machine, and its repository, as that machine's. */
const noteForeign = (checkout: Checkout | undefined): void => {
  if (checkout === undefined) return;
  const paths = [checkout.path, ...(checkout.repoRoot === undefined ? [] : [checkout.repoRoot])];
  // This machine's own checkouts are never another's, whatever a host records at, above or below
  // them: their links are always followed here.
  if (isLocalHost(checkout)) keepPathsHere(paths.filter((path) => isAbsolute(path)));
  else for (const path of paths) noteForeignPath(path);
};

/**
 * Marks the folders a thread holds on another machine (its checkouts and their repositories) as
 * that machine's, so comparing them here never asks this filesystem (`noteForeignPath`), and keeps
 * this machine's own as this machine's (`keepPathsHere`). Called wherever threads are read or
 * written, before anything keys or compares their paths.
 */
export const noteForeignCheckouts = (
  thread: Pick<Thread, "checkout" | "currentCheckout" | "extraCheckouts">,
): void => {
  noteForeign(thread.checkout);
  noteForeign(thread.currentCheckout);
  for (const extra of thread.extraCheckouts ?? []) noteForeign(extra);
};
