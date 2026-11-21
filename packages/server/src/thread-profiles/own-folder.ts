import {
  type Checkout,
  type HostId,
  InvalidState,
  LOCAL_HOST_ID,
  type ProfileFile,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { olderHost } from "../host/folders.ts";
import type { HostThreadPlaces } from "../host/thread-places.ts";
import type { WorkerHostsShape } from "../host/worker-host.ts";
import { layProfileFiles } from "./lay.ts";

/** Where the folders of threads whose workplace is none or scratch are made, under the data folder. */
export const PROFILE_THREADS_DIR = "profile-threads";

/** What a caller hears where a thread's machine can't be reached from here (a test layer). */
export const NOT_PLACED_HERE = "This server has no joined machines to place the thread on.";

const refuse = (message: string) => new InvalidState({ message });

/**
 * A joined machine's places for threads, looked up at each use since a machine's host lasts only
 * as long as its connection. Refused for a machine that went, or whose host is older.
 */
export const placesOn = (
  hosts: Pick<WorkerHostsShape, "get"> | undefined,
  hostId: HostId,
): Effect.Effect<HostThreadPlaces, InvalidState> =>
  hosts === undefined
    ? Effect.fail(refuse(NOT_PLACED_HERE))
    : hosts.get(hostId).pipe(
        Effect.mapError((error) => refuse(error.message)),
        Effect.flatMap((host) =>
          host.threadPlaces === undefined
            ? Effect.fail(refuse(olderHost({ name: host.name ?? hostId })))
            : Effect.succeed(host.threadPlaces),
        ),
      );

/** A folder made for a thread, and how to take it back. */
export interface OwnFolder {
  readonly checkout: Checkout;
  /** Deletes the folder, wherever it is; a failure to is logged, never raised. */
  readonly remove: Effect.Effect<void>;
}

/**
 * `threadId`'s own new folder with `files` laid in it: on `hostId`, a joined machine, by its host;
 * with none, here under `dataDir`. Before anything is made, a machine that can't make one refuses.
 */
export const makeOwnFolder = (
  deps: {
    readonly dataDir: string;
    readonly hosts: Pick<WorkerHostsShape, "get"> | undefined;
  },
  threadId: ThreadId,
  files: ReadonlyArray<ProfileFile>,
  hostId: HostId | undefined,
): Effect.Effect<OwnFolder, InvalidState> =>
  Effect.gen(function* () {
    if (hostId !== undefined && hostId !== LOCAL_HOST_ID) {
      const places = yield* placesOn(deps.hosts, hostId);
      const { path } = yield* places.make(threadId, files);
      return { checkout: { kind: "main", path, hostId }, remove: places.remove(threadId) };
    }
    const folder = join(deps.dataDir, PROFILE_THREADS_DIR, threadId);
    const remove = Effect.promise(() =>
      rm(folder, { recursive: true, force: true }).catch(() => undefined),
    );
    yield* layProfileFiles(folder, files).pipe(Effect.tapError(() => remove));
    return { checkout: { kind: "main", path: folder }, remove };
  });
