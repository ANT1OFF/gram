import { type Checkout, isLocalHost, type Thread } from "@gram/contracts";
import {
  isInside,
  keepPathsHere,
  noteForeignPath,
  PendingPaths,
  pathForms,
  tryRealPathSync,
} from "@gram/git";
import { dirname, isAbsolute, resolve, win32 } from "node:path";

const folded = (path: string): string =>
  process.platform === "darwin" || process.platform === "win32" ? path.toLowerCase() : path;

const ownFolders = new Set<string>();

const ownPending = new PendingPaths();

const HERE_FORMS_MS = 30_000;

let hereFormsByPath = new Map<string, { forms: ReadonlyArray<string>; until: number }>();

/** Forgets every `keepFoldersHere`, for tests. */
export const forgetOwnFoldersForTest = (): void => {
  ownFolders.clear();
  ownPending.clear();
  hereFormsByPath = new Map();
};

/**
 * Keeps `paths` (the server's data folder) this machine's: a checkout a host records at one of
 * them, above one or below one, never routes there or marks it as another machine's. A relative
 * path is taken against the working directory. One that isn't there yet is kept by its real path
 * too once it is.
 */
export const keepFoldersHere = (paths: ReadonlyArray<string>): void => {
  keepPathsHere(paths);
  for (const path of paths) {
    const resolved = resolve(path);
    for (const form of pathForms(resolved)) ownFolders.add(folded(form));
    if (tryRealPathSync(resolved) === undefined) ownPending.add(resolved);
  }
};

/**
 * The folders of this server's that a host's never claims, as `main.ts` keeps them: its data
 * folder alone. Not the folder it runs in, which is `/` for an app opened from the Finder, a
 * service or a container, and so would hold every path a host records.
 */
export const keepServerFolders = (dataDir: string): void => keepFoldersHere([dataDir]);

/**
 * `paths` (absolute, this machine's) by every spelling of them on this disk (`pathForms`), folded.
 * A path's spellings are taken from the disk at most every half minute: the folders above a
 * checkout are rarely relinked, and every placement asks for all of them.
 */
export const hereForms = (paths: Iterable<string>): ReadonlyArray<string> => {
  const now = Date.now();
  const known = new Map<string, { forms: ReadonlyArray<string>; until: number }>();
  const forms = new Set<string>();
  for (const path of paths) {
    if (!isAbsolute(path)) continue;
    let entry = known.get(path) ?? hereFormsByPath.get(path);
    if (entry === undefined || entry.until <= now)
      entry = { forms: pathForms(path).map(folded), until: now + HERE_FORMS_MS };
    known.set(path, entry);
    for (const form of entry.forms) forms.add(form);
  }
  hereFormsByPath = known;
  return [...forms];
};

/**
 * Whether a host's recorded folder may be taken as that machine's: one that is, holds or lies under
 * a folder of this server's (`keepFoldersHere`) may not, and neither may one that holds or lies
 * under one of `here` (this machine's checkouts, as `hereForms` gives them). The very path of one
 * of `here` may: two machines can hold the same path, which then names both.
 */
export const claimableByHost = (path: string, here: ReadonlyArray<string> = []): boolean => {
  if (!isAbsolute(path)) return win32.isAbsolute(path);
  for (const pending of ownPending.settle())
    for (const form of pathForms(pending)) ownFolders.add(folded(form));
  const at = folded(resolve(path));
  for (const own of ownFolders) if (isInside(at, own) || isInside(own, at)) return false;
  const { forms, foldersAbove } = indexOfHere(here);
  if (foldersAbove.has(at)) return false;
  for (let up = at; dirname(up) !== up;) {
    up = dirname(up);
    if (forms.has(up)) return false;
  }
  return true;
};

const hereIndexes = new WeakMap<
  ReadonlyArray<string>,
  { forms: ReadonlySet<string>; foldersAbove: ReadonlySet<string> }
>();

const indexOfHere = (here: ReadonlyArray<string>) => {
  let index = hereIndexes.get(here);
  if (index !== undefined) return index;
  const foldersAbove = new Set<string>();
  for (const form of here)
    for (let up = form; dirname(up) !== up;) {
      up = dirname(up);
      if (foldersAbove.has(up)) break;
      foldersAbove.add(up);
    }
  index = { forms: new Set(here), foldersAbove };
  hereIndexes.set(here, index);
  return index;
};

const noteForeign = (checkout: Checkout | undefined): void => {
  if (checkout === undefined) return;
  const paths = [checkout.path, ...(checkout.repoRoot === undefined ? [] : [checkout.repoRoot])];
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
