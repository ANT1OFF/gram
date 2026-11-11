// Starting a thread from a profile (`thread.createFromProfile`): the profile is checked whole,
// its workplace made and its files laid there, and the thread created with what it keeps of the
// profile (`Thread.profile`), which every session it opens is then given again (`policy.ts`).
import {
  decodeThreadProfile,
  embeddingOn,
  InvalidState,
  type ModelRef,
  orchestrationMode,
  profileBindingOf,
  profileFilesOf,
  type Thread,
  ThreadId,
  type ThreadProfile,
  type AgentUnavailable,
  type HostId,
  LOCAL_HOST_ID,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { makeKeyedLock } from "../git/keyed-lock.ts";
import { olderHost } from "../host/folders.ts";
import type { HostThreadPlaces } from "../host/thread-places.ts";
import type { WorkerHostsShape } from "../host/worker-host.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes-shape.ts";
import { layProfileFiles } from "./lay.ts";
import type { ProfileRepositories } from "./repositories.ts";

export { layProfileFiles } from "./lay.ts";

/** What a caller hears while the hosted features are off. */
export const PROFILES_OFF =
  "Starting a thread from a profile is one of the hosted features, which are off here.";

/** Where the folders of threads whose workplace is none or scratch are made, under the data folder. */
export const PROFILE_THREADS_DIR = "profile-threads";

/** The name of the project those threads are filed under. */
export const PROFILE_THREADS_PROJECT = "Profile threads";

/** What a caller hears where there is no git to clone with (a test layer without `Proc`). */
export const NO_REPOSITORIES_HERE =
  "A profile whose workplace is repositories can't be started here: this server has no git to clone them with.";

/** What a caller hears where a thread's machine can't be reached from here (a test layer). */
export const NOT_PLACED_HERE = "This server has no joined machines to place the thread on.";

export interface ProfileStarterDeps {
  readonly store: Pick<
    ThreadStoreShape,
    "getSettings" | "listProfiles" | "ensureProject" | "getThread" | "listClosed"
  >;
  readonly runtimes: Pick<ThreadRuntimesShape, "create" | "close">;
  /** The server's data folder (`ServerConfig.dataDir`). */
  readonly dataDir: string;
  /** Clones and worktrees for a workplace of repositories; absent where there is no git. */
  readonly repositories?: ProfileRepositories | undefined;
  /**
   * The machines work is placed on. On a headless server, which runs no work itself, the thread
   * goes on the joined machine it places what names none on; absent, or anywhere else, on this one.
   */
  readonly hosts?: Pick<WorkerHostsShape, "headless" | "get"> | undefined;
}

const refuse = (message: string) => new InvalidState({ message });

/** An id a caller may give its thread: a UUID, as Gram's own are, since it names folders too. */
const SUPPLIED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The model a profile names, as a thread runs on it. */
const modelOf = (profile: ThreadProfile): ModelRef => ({
  agent: profile.agent,
  model: profile.model.model,
  ...(profile.model.effort === undefined ? {} : { variant: profile.model.effort }),
  ...(profile.model.gatewayProfile === undefined
    ? {}
    : { profileId: profile.model.gatewayProfile }),
});

export const makeProfileStarter = ({
  store,
  runtimes,
  dataDir,
  repositories,
  hosts,
}: ProfileStarterDeps) => {
  /**
   * A joined machine's places for the thread, looked up at each use since a machine's host lasts
   * only as long as its connection. Refused for a machine that went, or whose host is older.
   */
  const placesOn = (hostId: HostId): Effect.Effect<HostThreadPlaces, InvalidState> =>
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

  // One start per supplied id at a time, so two asks for the same id make one thread.
  const starting = makeKeyedLock<ThreadId>();

  /**
   * The thread `value` describes, started. Refused before anything is made: with the hosted
   * features off, for a value that isn't a profile of this version, and for one naming a gateway
   * profile this Gram doesn't have.
   *
   * With `asked`, the thread gets that id, and a start asked for again answers the thread the
   * first one made, as it is now (in error too, when its agent couldn't open), without reading the
   * profile again. An id another kind of thread has, or one whose thread was closed, is refused.
   */
  const start = (
    value: unknown,
    asked?: ThreadId,
  ): Effect.Effect<Thread, InvalidState | AgentUnavailable> => {
    if (asked === undefined) return startAs(value, Schema.decodeSync(ThreadId)(randomUUID()));
    return Effect.gen(function* () {
      if (!embeddingOn(yield* store.getSettings)) return yield* refuse(PROFILES_OFF);
      if (!SUPPLIED_ID.test(asked))
        return yield* refuse("A thread id given with a profile is a lowercase UUID.");
      return yield* starting.withLock(
        asked,
        Effect.gen(function* () {
          const existing = yield* store.getThread(asked).pipe(Effect.option);
          if (Option.isSome(existing)) {
            return existing.value.profile === undefined
              ? yield* refuse("That thread id is another thread's.")
              : existing.value;
          }
          if ((yield* store.listClosed).some((closed) => closed.thread.id === asked))
            return yield* refuse("The thread with that id was closed.");
          return yield* startAs(value, asked);
        }),
      );
    });
  };

  const startAs = (
    value: unknown,
    id: ThreadId,
  ): Effect.Effect<Thread, InvalidState | AgentUnavailable> =>
    Effect.gen(function* () {
      const settings = yield* store.getSettings;
      if (!embeddingOn(settings)) return yield* refuse(PROFILES_OFF);
      const decoded = decodeThreadProfile(value);
      if (!decoded.ok) {
        return yield* refuse(`That profile can't be applied. ${decoded.problems.join(" ")}`);
      }
      const { profile } = decoded;
      const { workplace } = profile;
      if (workplace.kind === "repositories" && repositories === undefined) {
        return yield* refuse(NO_REPOSITORIES_HERE);
      }
      const gateway = profile.model.gatewayProfile;
      if (gateway !== undefined && !(yield* store.listProfiles).some((p) => p.id === gateway)) {
        return yield* refuse(
          `There is no gateway profile ${gateway} here for the model to run on.`,
        );
      }

      const files = profileFilesOf(profile);
      const base = {
        id,
        model: modelOf(profile),
        // It runs with nobody at the composer, as an orchestrator's worker does.
        mode: orchestrationMode(settings),
        ...(profile.name === undefined || profile.name.trim() === ""
          ? {}
          : // Its title until it gets one: not the user's own, so a later name may replace it.
            { title: profile.name.trim(), kept: { userNamed: false } }),
        ...(profile.input === undefined ? {} : { input: { text: profile.input } }),
        profile: profileBindingOf(profile),
      };

      if (workplace.kind === "repositories" && repositories !== undefined) {
        const place = yield* repositories.prepare(id, workplace.repositories);
        const checkouts = [place.checkout, ...place.extraCheckouts];
        const made = Effect.gen(function* () {
          // The files go where the worktree is: on the machine a headless server placed it on,
          // by that machine's host, or here.
          const on = place.checkout.hostId;
          if (on === undefined || on === LOCAL_HOST_ID) {
            const laid = yield* layProfileFiles(place.checkout.path, files, { keepExisting: true });
            yield* repositories.exclude(place.checkout.path, laid);
          } else if (files.length > 0) {
            yield* (yield* placesOn(on)).lay(place.checkout.path, files);
          }
          return yield* runtimes.create({
            ...base,
            projectRoot: place.projectRoot,
            checkout: place.checkout,
            extraCheckouts: place.extraCheckouts,
            // The other repositories are the thread's to work in too, as a worker's are.
            additionalDirectories: place.extraCheckouts.map((extra) => extra.path),
          });
        });
        // A start that fails leaves nothing: the thread goes first, if it was stored, then the
        // worktrees made for it. The clones stay, for the next thread of the same repository.
        return yield* made.pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : runtimes
                  .close(id)
                  .pipe(
                    Effect.ignore,
                    Effect.andThen(
                      Effect.forEach(checkouts, repositories.discard, { discard: true }),
                    ),
                  ),
          ),
        );
      }

      const root = join(dataDir, PROFILE_THREADS_DIR);
      if (hosts?.headless !== undefined) {
        // A headless server runs nothing here: the folder is made on the machine that takes what
        // names none, by its host, and the thread is filed under the same project.
        const hostId = yield* hosts.headless.machine;
        const places = yield* placesOn(hostId);
        // Before anything is taken back: a folder this start didn't make isn't its to remove.
        const { path } = yield* places.make(id, files);
        const made = Effect.gen(function* () {
          // The project's folder here holds nothing; it is what the threads are filed under.
          yield* Effect.promise(() => mkdir(root, { recursive: true }).catch(() => undefined));
          yield* store.ensureProject({ root, name: PROFILE_THREADS_PROJECT });
          return yield* runtimes.create({
            ...base,
            projectRoot: root,
            checkout: { kind: "main", path, hostId },
          });
        });
        return yield* made.pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : runtimes.close(id).pipe(Effect.ignore, Effect.andThen(places.remove(id))),
          ),
        );
      }
      const folder = join(root, id);
      const made = Effect.gen(function* () {
        yield* layProfileFiles(folder, files);
        // Named once here; `create` would otherwise name the project for its folder.
        yield* store.ensureProject({ root, name: PROFILE_THREADS_PROJECT });
        return yield* runtimes.create({
          ...base,
          projectRoot: root,
          checkout: { kind: "main", path: folder },
        });
      });
      // A start that fails, at whatever step, leaves nothing: a supplier that tries again would
      // otherwise pile up threads that never ran and folders nothing owns. The thread goes first,
      // if it got as far as being stored, then its folder.
      return yield* made.pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : runtimes
                .close(id)
                .pipe(
                  Effect.ignore,
                  Effect.andThen(
                    Effect.promise(() =>
                      rm(folder, { recursive: true, force: true }).catch(() => undefined),
                    ),
                  ),
                ),
        ),
      );
    });

  return { start };
};
