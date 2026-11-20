import { type Checkout, isLocalHost, type Thread } from "@gram/contracts";
import { isInside, noteForeignPath } from "@gram/git";
import { isAbsolute, resolve, win32 } from "node:path";

/** This server's own folders (`keepFoldersHere`), which no machine's word makes another's. */
const ownFolders = new Set<string>();

/**
 * Keeps `paths` (the server's data folder, the folder it runs in) this machine's: a checkout a
 * host records at one of them, or above one, never routes them to that host or marks them as
 * another machine's.
 */
export const keepFoldersHere = (paths: ReadonlyArray<string>): void => {
  for (const path of paths) if (isAbsolute(path)) ownFolders.add(resolve(path));
};

/**
 * Whether a host's recorded folder may be taken as that machine's: one that is, or holds, a folder
 * of this server's, or any folder of `here` (this machine's checkouts), may not.
 */
export const claimableByHost = (path: string, here: Iterable<string> = []): boolean => {
  // A path from a machine of another platform can't hold one of this server's folders.
  if (!isAbsolute(path)) return win32.isAbsolute(path);
  const at = resolve(path);
  for (const own of ownFolders) if (isInside(at, own)) return false;
  for (const mine of here)
    if (isAbsolute(mine) && at !== resolve(mine) && isInside(at, mine)) return false;
  return true;
};

/** Forgets every `keepFoldersHere`, for tests. */
export const forgetOwnFoldersForTest = (): void => ownFolders.clear();

/** Marks one checkout on another machine, and its repository, as that machine's. */
const noteForeign = (checkout: Checkout | undefined): void => {
  if (checkout === undefined || isLocalHost(checkout)) return;
  if (claimableByHost(checkout.path)) noteForeignPath(checkout.path);
  if (checkout.repoRoot !== undefined && claimableByHost(checkout.repoRoot))
    noteForeignPath(checkout.repoRoot);
};

/**
 * Marks the folders a thread holds on another machine (its checkouts and their repositories) as
 * that machine's, so comparing them here never asks this filesystem (`noteForeignPath`). Called
 * wherever threads are read or written, before anything keys or compares their paths.
 */
export const noteForeignCheckouts = (
  thread: Pick<Thread, "checkout" | "currentCheckout" | "extraCheckouts">,
): void => {
  noteForeign(thread.checkout);
  noteForeign(thread.currentCheckout);
  for (const extra of thread.extraCheckouts ?? []) noteForeign(extra);
};
