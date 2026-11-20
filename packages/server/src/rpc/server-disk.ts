import { type HostId, LOCAL_HOST_ID } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { resolve } from "node:path";
import { pathsMentioned } from "../embedding/readable-by.ts";

/**
 * What reaches this server's own disk rather than a thread's folder. Not `projects.clone`: on a
 * headless server it clones nothing and takes no path, only files the repository's origin under
 * the data folder (`fileOrigin`), and the machine a thread is placed on clones it with its own
 * credentials. That is how New project adds a repository there.
 */
export const SERVER_DISK: ReadonlySet<string> = new Set(["fs.browse", "fs.tree", "projects.add"]);
/** The listings that reach this server's own disk when they name no thread. */
export const SERVER_DISK_UNLESS_THREAD: ReadonlySet<string> = new Set(["fs.list", "fs.files"]);

/**
 * What runs git, `gh` or a folder's own config in a folder the call names. On a headless server
 * such a folder is a joined machine's, where the call is sent; one on this server's own disk is
 * nobody's work, and could be a repository a person planted there (through the shared folder, or
 * a path they know), whose hooks and config would run as the server. {@link namesServerDisk}.
 */
export const RUNS_IN_FOLDER: ReadonlySet<string> = new Set([
  "connectors.configured",
  "git.baseStatus",
  "git.branches",
  "git.fastForward",
  "git.fetchBase",
  "git.upstreamStatus",
  "git.upstreamSync",
  "pr.checkout",
  "projects.folderSettings",
  "worktree.cleanUp",
  "worktree.cleanupPlan",
  "worktree.list",
  "worktree.pendingPermissions",
  "worktree.pendingPermissionsAt",
  "worktree.remove",
  "worktree.size",
  "worktree.status",
  "worktree.storage",
]);

/**
 * Whether a call that runs in a folder names one on this server's own disk: a path no joined
 * machine's thread holds (`placeOf` says this machine's). A relative path, `~` included, would be
 * read against the server's own folders, so it counts as one of them. Without `placeOf` to ask,
 * every named folder does.
 */
export const namesServerDisk = (
  payload: unknown,
  placeOf: ((path: string) => Effect.Effect<HostId | undefined>) | undefined,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    for (const path of pathsMentioned(payload, [resolve("/")])) {
      if (placeOf === undefined) return true;
      if ((yield* placeOf(path)) === LOCAL_HOST_ID) return true;
    }
    return false;
  });

export const SERVER_DISK_REFUSAL =
  "this server runs nothing in a folder on its own disk for the people signed in to it: name a folder of a thread's machine";
