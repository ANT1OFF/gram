import {
  InvalidState,
  isSharedWorkspaceId,
  type SharedListing,
  type SharedPart,
  type WorkspaceId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { join, resolve } from "node:path";
import type { SharedSide } from "./sync.ts";
import { sharedTree, type SharedTree, type SharedWrite } from "./tree.ts";

/** A machine's shared-folder mirrors, by workspace; `E` is how a call fails. */
export interface HostShared<E = unknown> {
  readonly open: (workspaceId: WorkspaceId) => Effect.Effect<{ readonly path: string }, E>;
  readonly list: (workspaceId: WorkspaceId) => Effect.Effect<SharedListing, E>;
  readonly read: (
    workspaceId: WorkspaceId,
    path: string,
    offset: number,
    length: number,
  ) => Effect.Effect<SharedPart, E>;
  readonly write: (
    workspaceId: WorkspaceId,
    write: SharedWrite,
  ) => Effect.Effect<{ readonly placed: boolean }, E>;
  readonly remove: (
    workspaceId: WorkspaceId,
    path: string,
    ifMatch: string,
  ) => Effect.Effect<{ readonly removed: boolean }, E>;
}

/** One workspace's mirror on a machine, as one side of a sync. */
export const sideOf = <E>(shared: HostShared<E>, workspaceId: WorkspaceId): SharedSide => ({
  list: shared.list(workspaceId),
  read: (path, offset, length) => shared.read(workspaceId, path, offset, length),
  write: (write) => shared.write(workspaceId, write),
  remove: (path, ifMatch) => shared.remove(workspaceId, path, ifMatch),
});

/** A tree for each workspace under `root`, made as each is first named. */
export const sharedTrees = (root: string) => {
  const base = resolve(root);
  const trees = new Map<string, SharedTree>();
  return (workspaceId: string): Effect.Effect<SharedTree, InvalidState> => {
    if (!isSharedWorkspaceId(workspaceId))
      return Effect.fail(new InvalidState({ message: `Not a workspace id: ${workspaceId}` }));
    let tree = trees.get(workspaceId);
    if (tree === undefined) {
      tree = sharedTree(join(base, workspaceId));
      trees.set(workspaceId, tree);
    }
    return Effect.succeed(tree);
  };
};

/** This machine's mirrors under `root`, as its host serves them. */
export const sharedOnHost = (root: string): HostShared<InvalidState> => {
  const treeOf = sharedTrees(root);
  return {
    open: (workspaceId) =>
      treeOf(workspaceId).pipe(
        Effect.flatMap((tree) => tree.open),
        Effect.map((path) => ({ path })),
      ),
    list: (workspaceId) => treeOf(workspaceId).pipe(Effect.flatMap((tree) => tree.list)),
    read: (workspaceId, path, offset, length) =>
      treeOf(workspaceId).pipe(Effect.flatMap((tree) => tree.read(path, offset, length))),
    write: (workspaceId, write) =>
      treeOf(workspaceId).pipe(Effect.flatMap((tree) => tree.write(write))),
    remove: (workspaceId, path, ifMatch) =>
      treeOf(workspaceId).pipe(Effect.flatMap((tree) => tree.remove(path, ifMatch))),
  };
};
