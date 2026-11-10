import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  type FolderListing,
  type HostFolderChecked,
  InvalidState,
  isCredentialFolder,
  type NotFound,
} from "@gram/contracts";
import { git, isInside, Proc, type ProcShape, realPath } from "@gram/git";
import * as Effect from "effect/Effect";
import { browseFolders, expandHome, folderError } from "../fs/folders.ts";
import { hostHome } from "./host-config.ts";

/**
 * A machine's folders for a one-off thread the user places there: listed for the picker and
 * checked before a session starts in one. Everything here runs on the machine itself, its paths its
 * own, so `~` is its home.
 */
export interface HostFolders {
  /** Folders as `fs.browse` lists them, without the ones a thread may never run in. */
  readonly browse: (
    input: string,
    limit: number,
  ) => Effect.Effect<FolderListing, NotFound | InvalidState>;
  /** The folder a thread may run in, links resolved, or why it may not. */
  readonly check: (path: string) => Effect.Effect<HostFolderChecked, NotFound | InvalidState>;
}

/** Where the folders a thread may never run in are, on the machine. */
export interface FolderBounds {
  readonly home: string;
  /** The host's own folder: its key, its config, its token and the clones it keeps. */
  readonly hostHome: string;
}

/**
 * Why the picker never lists or opens `path` (absolute, as the machine spells it), or `undefined`:
 * a credential folder or one inside it (`~/.ssh`, `~/.aws`, …), and the host's own folder, whose
 * worktrees a worker reaches only through its own checkout.
 */
export const hiddenFolder = (path: string, bounds: FolderBounds): string | undefined => {
  if (isCredentialFolder(path))
    return `Gram doesn't run a chat in ${path}: it holds keys or credentials.`;
  if (isInside(bounds.hostHome, path))
    return `Gram doesn't run a chat in ${path}: it is Gram Host's own folder.`;
  return undefined;
};

/**
 * Why a thread may not run in `path`, or `undefined` when it may: a folder the picker hides, or the
 * whole filesystem, which can be browsed through but is no place for a chat.
 */
export const folderRefusal = (path: string, bounds: FolderBounds): string | undefined =>
  resolve(path) === resolve("/")
    ? "Gram doesn't run a chat in the whole filesystem."
    : hiddenFolder(path, bounds);

/** What a call says to a machine whose host is from a build before the call was. */
export const olderHost = (machine: { readonly name: string }) =>
  `gram-host on ${machine.name} is older than this Gram; update it (Settings → Machines, or rerun its install command there).`;

/** `path` with its links resolved, on the machine this runs on. */
const realOf = (path: string) =>
  Effect.tryPromise({ try: () => realPath(path), catch: (error) => folderError(error, path) });

const refused = (message: string) => new InvalidState({ message });

/**
 * The folders of the machine this runs on. A folder is refused by its path as typed and by its real
 * path, so a link to `~/.ssh` is refused as `~/.ssh` is.
 */
export const foldersOn = (
  proc: ProcShape,
  bounds: FolderBounds = { home: homedir(), hostHome: hostHome() },
): HostFolders => {
  const refuseBy = (judge: typeof folderRefusal) => (path: string) => {
    const why = judge(path, bounds);
    return why === undefined ? Effect.void : Effect.fail(refused(why));
  };
  const hide = refuseBy(hiddenFolder);
  const refuse = refuseBy(folderRefusal);

  return {
    browse: (input, limit) =>
      Effect.gen(function* () {
        const listing = yield* browseFolders(input, { home: bounds.home, limit });
        yield* hide(listing.path);
        yield* hide(yield* realOf(listing.path));
        // Judged by path alone: a link among them that leads somewhere refused is caught by `check`.
        const entries = listing.entries.filter(
          (entry) => hiddenFolder(entry.path, bounds) === undefined,
        );
        return { ...listing, entries };
      }),
    check: (path) =>
      Effect.gen(function* () {
        const typed = resolve(expandHome(path.trim(), bounds.home));
        yield* refuse(typed);
        const real = yield* realOf(typed);
        yield* refuse(real);
        const info = yield* Effect.tryPromise({
          try: () => stat(real),
          catch: (error) => folderError(error, real),
        });
        if (!info.isDirectory()) return yield* refused(`Not a folder: ${real}`);
        const branch = yield* git(real, ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
          Effect.map((out) => {
            const name = out.stdout.trim();
            return out.status === 0 && name !== "" && name !== "HEAD" ? name : undefined;
          }),
          // No git there, or not a repository: a folder like any other.
          Effect.orElseSucceed(() => undefined),
          Effect.provideService(Proc, proc),
        );
        return { path: real, ...(branch === undefined ? {} : { branch }) };
      }),
  };
};
