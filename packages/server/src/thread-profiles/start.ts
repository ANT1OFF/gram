// Starting a thread from a profile (`thread.createFromProfile`): the profile is checked whole,
// its workplace made and its files laid there, and the thread created with what it keeps of the
// profile (`Thread.profile`), which every session it opens is then given again (`policy.ts`).
import {
  AWAITED_HOST_ID,
  type AwaitingMachine,
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
  type ProfileFile,
} from "@gram/contracts";
import { keepsOwner, mayPlaceAwaited, sameOwner } from "../host/ownership.ts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { makeKeyedLock } from "../git/keyed-lock.ts";
import { ActingPerson } from "../embedding/person.ts";
import { olderHost } from "../host/folders.ts";
import { HOST_THREADS_DIR, type HostThreadPlaces } from "../host/thread-places.ts";
import { WAKE_WAIT_MS, type WorkerHostsShape } from "../host/worker-host.ts";
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

/** What a caller hears for a placement on this machine: `on` names a joined one. */
export const NAME_A_MACHINE = "Name a joined machine to place the thread on, or none.";

/** What a start asked for again hears when it names another machine than the thread's. */
export const ON_ANOTHER_MACHINE = "The thread with that id is on another machine.";

/** What a start that asks for a machine now and for one later is told. */
export const NOW_OR_LATER = "Name the thread's machine, or ask for it to be named later; not both.";

/** What a start with its machine named later is told for a workplace of repositories. */
export const REPOSITORIES_NEED_A_MACHINE =
  "A profile whose workplace is repositories is started on its machine: its checkouts are made there. Start the thread once the machine is online, and name it.";

/** What a start is told that names who started it without asking for the machine later. */
export const STARTED_BY_NEEDS_LATER =
  "Who started the thread is recorded only for one whose machine is named later.";

/** What a start hears for a person's id that isn't one. */
export const NOT_A_PERSON = "The person who started the thread is given by their sign-in's id.";

/** What a start naming a machine hears for a thread, asked for again, that still waits for one. */
export const WAITS_TO_BE_NAMED =
  "The thread with that id waits for its machine. Name it by moving the thread to it.";

/** What a wait's state is asked of a thread that doesn't wait for a machine. */
export const NOT_WAITING = "That thread isn't waiting for a machine.";

/** What a thread says when no machine was named for it in `AWAITED_FOR_MS`. */
export const NO_MACHINE_CAME =
  "No machine started for this thread. What you sent is kept, and goes once one has.";

/**
 * How long a thread waits for its machine to be named before it says none came: as long as a
 * session about to open waits for a stopped machine (`WAKE_WAIT_MS`).
 */
export const AWAITED_FOR_MS = WAKE_WAIT_MS;

/** A person's stable subject, as fronted sign-in names them: printable, at most 128 characters. */
const PERSON = /^[\x21-\x7e]{1,128}$/;

/** How a start is asked for, beside its profile. */
export interface ProfileStartOptions {
  /** The caller's own id for the thread, a lowercase UUID: a start asked for again makes one. */
  readonly threadId?: ThreadId | undefined;
  /** The joined machine the thread goes on. */
  readonly on?: HostId | undefined;
  /**
   * `later`: the thread is made with no machine, and waits for one to be named (`moveOne`). Its
   * first message waits in its queue. Only for a workplace of none or scratch.
   */
  readonly machine?: "later" | undefined;
  /** With `machine: "later"`: the signed-in person the thread is started by. */
  readonly startedBy?: string | undefined;
}

/** A thread a start answered, and whether that start made it. */
export interface ProfileStarted {
  readonly thread: Thread;
  readonly created: boolean;
}

/** What a caller hears where a thread's machine can't be reached from here (a test layer). */
export const NOT_PLACED_HERE = "This server has no joined machines to place the thread on.";

/** A thread moved, and whether this call moved it. */
export interface ProfileMoved {
  readonly thread: Thread;
  readonly moved: boolean;
}

/** What a move hears for a thread that isn't one started from a profile into a folder of its own. */
export const NOT_MOVABLE =
  "Only a thread started from a profile that works in a folder of its own, on a joined machine, moves.";

/** What a move hears for a machine started for someone else than the thread's. */
export const NOT_THE_THREADS_OWNER =
  "That machine was started for someone else than the thread is for, so the thread can't move to it.";

/** What a move hears for a thread whose machine is no longer on record. */
export const OWNER_UNKNOWN =
  "The thread's machine is no longer on record, so who the thread is for can't be told. It doesn't move.";

/** What a move hears for a thread at work. */
export const THREAD_AT_WORK =
  "The thread is at work, or has something open on its machine, so it doesn't move now.";

/** What a move hears while the thread's machine is still there. */
export const MACHINE_STILL_THERE =
  "The thread's machine is online, so the thread stays on it. Move it once that machine is gone.";

export interface ProfileStarterDeps {
  readonly store: Pick<
    ThreadStoreShape,
    "getSettings" | "listProfiles" | "ensureProject" | "getThread" | "listClosed"
  > &
    Partial<Pick<ThreadStoreShape, "listThreads">>;
  /**
   * With `relocate` where threads can be moved (`moveOne`), and `updateThread` and `startSession`
   * where one can wait for its machine.
   */
  readonly runtimes: Pick<ThreadRuntimesShape, "create" | "close"> &
    Partial<Pick<ThreadRuntimesShape, "relocate" | "updateThread" | "startSession">>;
  /**
   * The joined machines' records, for whom each was started (`owner`, `onDemand`, where the
   * server records them): a thread moves only between machines started for the same person and
   * the same purpose, or between machines started for nobody. Absent: nothing moves.
   */
  readonly machines?: { readonly get: (id: HostId) => object | undefined } | undefined;
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
  machines,
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
   * The thread `value` describes, started, and whether this call made it. Refused before anything
   * is made: with the hosted features off, for a value that isn't a profile of this version, for
   * one naming a gateway profile this Gram doesn't have, and for a machine `on` names that isn't
   * joined and online.
   *
   * With `threadId`, the thread gets that id, and a start asked for again answers the thread the
   * first one made, as it is now (in error too, when its agent couldn't open), without reading the
   * profile or `on` again. An id another kind of thread has, or one whose thread was closed, is
   * refused.
   *
   * With `on`, the thread is placed on that joined machine: its folder made there by the machine's
   * host, or its worktrees made from the machine's clones. Without it, a headless server places it
   * on its default machine and any other server here.
   */
  const startOne = (
    value: unknown,
    options: ProfileStartOptions = {},
  ): Effect.Effect<ProfileStarted, InvalidState | AgentUnavailable> => {
    const { threadId: asked, on } = options;
    const fresh = (id: ThreadId) =>
      (options.machine === "later"
        ? startAwaiting(value, id, options.startedBy)
        : startAs(value, id, on)
      ).pipe(Effect.map((thread) => ({ thread, created: true })));
    if (options.machine === "later" && on !== undefined) return Effect.fail(refuse(NOW_OR_LATER));
    if (options.startedBy !== undefined && options.machine !== "later")
      return Effect.fail(refuse(STARTED_BY_NEEDS_LATER));
    if (options.startedBy !== undefined && !PERSON.test(options.startedBy))
      return Effect.fail(refuse(NOT_A_PERSON));
    if (asked === undefined) return fresh(Schema.decodeSync(ThreadId)(randomUUID()));
    return Effect.gen(function* () {
      if (!embeddingOn(yield* store.getSettings)) return yield* refuse(PROFILES_OFF);
      if (!SUPPLIED_ID.test(asked))
        return yield* refuse("A thread id given with a profile is a lowercase UUID.");
      return yield* starting.withLock(
        asked,
        Effect.gen(function* () {
          const existing = yield* store.getThread(asked).pipe(Effect.option);
          if (Option.isSome(existing)) {
            if (existing.value.profile === undefined)
              return yield* refuse("That thread id is another thread's.");
            // A machine asked for again must be where the thread is: an answer otherwise would
            // say it is there when it isn't.
            if (on !== undefined && existing.value.awaitingMachine !== undefined)
              return yield* refuse(WAITS_TO_BE_NAMED);
            if (on !== undefined && existing.value.checkout.hostId !== on)
              return yield* refuse(ON_ANOTHER_MACHINE);
            return { thread: existing.value, created: false };
          }
          if ((yield* store.listClosed).some((closed) => closed.thread.id === asked))
            return yield* refuse("The thread with that id was closed.");
          return yield* fresh(asked);
        }),
      );
    });
  };

  /** `startOne`'s thread alone, as `thread.createFromProfile` answers. */
  const start = (
    value: unknown,
    options: ProfileStartOptions = {},
  ): Effect.Effect<Thread, InvalidState | AgentUnavailable> =>
    startOne(value, options).pipe(Effect.map((started) => started.thread));

  const startAs = (
    value: unknown,
    id: ThreadId,
    on: HostId | undefined,
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
      // The machine named, checked before anything is cloned or made: joined, online now, and
      // with a host that makes thread folders.
      if (on === LOCAL_HOST_ID) return yield* refuse(NAME_A_MACHINE);
      const named = on === undefined ? undefined : yield* placesOn(on);

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
        const place = yield* repositories.prepare(id, workplace.repositories, on);
        const checkouts = [place.checkout, ...place.extraCheckouts];
        const made = Effect.gen(function* () {
          // The files go where the worktree is: on the machine a headless server placed it on,
          // by that machine's host, or here.
          const placedOn = place.checkout.hostId;
          if (placedOn === undefined || placedOn === LOCAL_HOST_ID) {
            const laid = yield* layProfileFiles(place.checkout.path, files, { keepExisting: true });
            yield* repositories.exclude(place.checkout.path, laid);
          } else if (files.length > 0) {
            yield* (yield* placesOn(placedOn)).lay(place.checkout.path, files);
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
      if (on !== undefined || hosts?.headless !== undefined) {
        // On the machine named, or, on a headless server that runs nothing here, the one that
        // takes what names none: the folder is made there by its host, and the thread is filed
        // under the same project.
        const hostId = on ?? (yield* hosts!.headless!.machine);
        const places = named ?? (yield* placesOn(hostId));
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

  /**
   * The thread `value` describes, made with no machine: stored, shown as waiting for its machine
   * (`Thread.awaitingMachine`), with the profile's first message in its queue as `startedBy`'s.
   * Nothing is made anywhere but the thread: its folder is made when its machine is named
   * (`moveOne`). Refused, with nothing made, as any start is, and for a workplace of repositories,
   * whose checkouts need the machine.
   */
  const startAwaiting = (
    value: unknown,
    id: ThreadId,
    startedBy: string | undefined,
  ): Effect.Effect<Thread, InvalidState | AgentUnavailable> =>
    Effect.gen(function* () {
      const settings = yield* store.getSettings;
      if (!embeddingOn(settings)) return yield* refuse(PROFILES_OFF);
      const decoded = decodeThreadProfile(value);
      if (!decoded.ok) {
        return yield* refuse(`That profile can't be applied. ${decoded.problems.join(" ")}`);
      }
      const { profile } = decoded;
      if (profile.workplace.kind === "repositories")
        return yield* refuse(REPOSITORIES_NEED_A_MACHINE);
      const gateway = profile.model.gatewayProfile;
      if (gateway !== undefined && !(yield* store.listProfiles).some((p) => p.id === gateway)) {
        return yield* refuse(
          `There is no gateway profile ${gateway} here for the model to run on.`,
        );
      }
      // Where there is nothing to name a machine with, the thread would wait for ever.
      if (hosts === undefined || runtimes.relocate === undefined)
        return yield* refuse(NOT_PLACED_HERE);
      const root = join(dataDir, PROFILE_THREADS_DIR);
      const made = Effect.gen(function* () {
        // The project's folder here holds nothing; it is what the threads are filed under.
        yield* Effect.promise(() => mkdir(root, { recursive: true }).catch(() => undefined));
        yield* store.ensureProject({ root, name: PROFILE_THREADS_PROJECT });
        const awaitingMachine: AwaitingMachine = {
          since: yield* Clock.currentTimeMillis,
          ...(startedBy === undefined ? {} : { startedBy }),
        };
        return yield* runtimes.create({
          id,
          model: modelOf(profile),
          mode: orchestrationMode(settings),
          ...(profile.name === undefined || profile.name.trim() === ""
            ? {}
            : { title: profile.name.trim(), kept: { userNamed: false } }),
          ...(profile.input === undefined ? {} : { input: { text: profile.input } }),
          profile: profileBindingOf(profile),
          projectRoot: root,
          // On no machine: nothing is reached through this id, and no folder is at this path.
          checkout: { kind: "main", path: awaitedFolder(id), hostId: AWAITED_HOST_ID },
          awaitingMachine,
        });
      });
      // As the person who started it, where the start named one: the thread's creator on the
      // record, and the writer of its first message, which is sent as theirs when it goes.
      return yield* (
        startedBy === undefined ? made : made.pipe(Effect.provideService(ActingPerson, startedBy))
      ).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : runtimes.close(id).pipe(Effect.ignore),
        ),
      );
    });

  /**
   * Places a thread that waits for its machine (`startAwaiting`) on `to`, a joined machine online
   * now: its folder made there with `value`'s files, the thread placed on it, and what waited in
   * its queue sent from there; with nothing waiting, its session opens and waits, as a start's
   * does. The runtime's fence (`relocate`) holds from before the folder is made until the thread is
   * placed, and the wait ends in the write that places it, so a naming asked for twice, at once or
   * after a restart cut the first short, places the thread once and sends its queue once.
   *
   * Refused, with the thread still waiting and its queue kept: for a `to` that isn't joined and
   * online; for a machine started for someone else than the thread was started by; and when
   * `value` isn't the profile the thread keeps what it was given of.
   */
  const placeAwaited = (
    thread: Thread,
    to: HostId,
    value: unknown,
  ): Effect.Effect<ProfileMoved, InvalidState> =>
    Effect.gen(function* () {
      const threadId = thread.id;
      const { relocate } = runtimes;
      if (hosts === undefined || machines === undefined || relocate === undefined)
        return yield* refuse(NOT_PLACED_HERE);
      const target = machines.get(to);
      if (
        target === undefined ||
        !mayPlaceAwaited((id) => (id === to ? stringField(target, "owner") : undefined), thread, to)
      )
        return yield* refuse(NOT_THE_THREADS_OWNER);
      let files: ReadonlyArray<ProfileFile> = [];
      if (value !== undefined) {
        const decoded = decodeThreadProfile(value);
        if (!decoded.ok)
          return yield* refuse(`That profile can't be applied. ${decoded.problems.join(" ")}`);
        if (!sameValue(profileBindingOf(decoded.profile), thread.profile))
          return yield* refuse("That isn't the profile the thread was started from.");
        files = profileFilesOf(decoded.profile);
      }
      const places = yield* placesOn(to);
      let made = false;
      const prepare = Effect.gen(function* () {
        // A folder a naming cut short left there is this thread's and nobody else's: made anew.
        yield* places.remove(threadId);
        const { path } = yield* places.make(threadId, files);
        made = true;
        return { kind: "main" as const, path, hostId: to };
      });
      const placed = yield* relocate(threadId, { from: thread.checkout, prepare }).pipe(
        Effect.tapError(() => (made ? places.remove(threadId) : Effect.void)),
        Effect.mapError((error) => (error._tag === "ThreadNotFound" ? refuse(NOT_MOVABLE) : error)),
      );
      // Nothing waited: the session opens and waits for the first message, as a start's does.
      // Refused where a message did wait, which the placement has sent.
      if (runtimes.startSession !== undefined)
        yield* runtimes.startSession(threadId).pipe(Effect.ignore);
      yield* Effect.logInfo("a thread that waited for its machine was placed").pipe(
        Effect.annotateLogs({ threadId, to }),
      );
      return { thread: placed, moved: true };
    });

  /**
   * How the wait of a thread started before its machine stands, as whoever starts the machines
   * says: with `failed`, no machine is coming, and the thread says so in that sentence; without
   * it, the wait begins again from now. The queue is kept either way, and `moveOne` still places
   * the thread. Refused for a thread that doesn't wait.
   */
  const waitOne = (
    threadId: ThreadId,
    change: { readonly failed?: string | undefined } = {},
  ): Effect.Effect<AwaitingMachine, InvalidState> =>
    Effect.gen(function* () {
      if (!embeddingOn(yield* store.getSettings)) return yield* refuse(PROFILES_OFF);
      if (!SUPPLIED_ID.test(threadId)) return yield* refuse("Not a thread id.");
      const { updateThread } = runtimes;
      if (updateThread === undefined) return yield* refuse(NOT_PLACED_HERE);
      const failed = change.failed?.trim();
      if (failed !== undefined && failed === "")
        return yield* refuse("Say why no machine is coming, in a sentence.");
      return yield* starting.withLock(
        threadId,
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const updated = yield* updateThread(threadId, (thread) =>
            thread.awaitingMachine === undefined
              ? thread
              : {
                  ...thread,
                  awaitingMachine: {
                    ...(thread.awaitingMachine.startedBy === undefined
                      ? {}
                      : { startedBy: thread.awaitingMachine.startedBy }),
                    ...(failed === undefined
                      ? { since: now }
                      : {
                          since: thread.awaitingMachine.since,
                          failed: { at: now, message: failed },
                        }),
                  },
                },
          ).pipe(Effect.mapError(() => refuse(NOT_WAITING)));
          if (updated.awaitingMachine === undefined) return yield* refuse(NOT_WAITING);
          return updated.awaitingMachine;
        }),
      );
    });

  /**
   * Says of every thread that has waited `AWAITED_FOR_MS` for its machine that none came
   * (`NO_MACHINE_CAME`), once each, and how many it said it of. Read from the stored threads, so a
   * wait a restart interrupted is still counted from when it began. The thread goes on waiting:
   * its queue is kept, and a machine named later places it.
   */
  const expireWaits: Effect.Effect<number> = Effect.gen(function* () {
    const { updateThread } = runtimes;
    if (store.listThreads === undefined || updateThread === undefined) return 0;
    if (!embeddingOn(yield* store.getSettings)) return 0;
    const now = yield* Clock.currentTimeMillis;
    const due = (thread: Thread) =>
      thread.awaitingMachine !== undefined &&
      thread.awaitingMachine.failed === undefined &&
      now - thread.awaitingMachine.since >= AWAITED_FOR_MS;
    let said = 0;
    for (const thread of (yield* store.listThreads).filter(due)) {
      yield* updateThread(thread.id, (current) =>
        // Read again in the write: named or failed meanwhile, it is left as it is.
        current.awaitingMachine === undefined || !due(current)
          ? current
          : {
              ...current,
              awaitingMachine: {
                ...current.awaitingMachine,
                failed: { at: now, message: NO_MACHINE_CAME },
              },
            },
      ).pipe(
        Effect.tap(() => Effect.sync(() => void said++)),
        Effect.ignore,
      );
    }
    return said;
  }).pipe(Effect.orElseSucceed(() => 0));

  /**
   * Moves a thread started from a profile onto `to`, a joined machine online now, when the machine
   * it is on has gone away: its own folder made again there, at the path it had, with `value`'s
   * files, and the thread placed on it. Its next session opens there, and a session waiting for the
   * old machine to come back opens there instead (`placed.ts`). Its conversation is the thread's
   * transcript here; the agent's own session, kept on the old machine, is not carried.
   *
   * Refused, with nothing changed: with the hosted features off; for a thread that is closed, isn't
   * one started from a profile, or works anywhere but a folder of its own on a joined machine (a
   * thread in repositories has work only its machine holds); while its machine is online; for a
   * `to` that isn't joined and online, or keeps thread folders at another path; and when `value`
   * isn't the profile the thread keeps what it was given of. A thread on `to` already is answered
   * as it is.
   *
   * A thread that waits for its machine (`startAwaiting`) is on none, so there is nothing to move
   * it off: naming `to` places it for the first time (`placeAwaited`).
   */
  const moveOne = (
    threadId: ThreadId,
    to: HostId,
    value?: unknown,
    options: { readonly lost?: boolean } = {},
  ): Effect.Effect<ProfileMoved, InvalidState> =>
    Effect.gen(function* () {
      if (!embeddingOn(yield* store.getSettings)) return yield* refuse(PROFILES_OFF);
      if (!SUPPLIED_ID.test(threadId)) return yield* refuse("Not a thread id.");
      if (to === LOCAL_HOST_ID) return yield* refuse(NAME_A_MACHINE);
      return yield* starting.withLock(
        threadId,
        Effect.gen(function* () {
          const found = yield* store.getThread(threadId).pipe(Effect.option);
          if (Option.isNone(found)) {
            const closed = (yield* store.listClosed).some((c) => c.thread.id === threadId);
            return yield* refuse(closed ? "The thread with that id was closed." : NOT_MOVABLE);
          }
          const thread = found.value;
          const { checkout } = thread;
          const from = checkout.hostId;
          if (thread.profile === undefined || !ownFolder(checkout, threadId) || from === undefined)
            return yield* refuse(NOT_MOVABLE);
          if (thread.awaitingMachine !== undefined) return yield* placeAwaited(thread, to, value);
          if (from === to) return { thread, moved: false };
          if (
            thread.currentCheckout !== undefined ||
            (thread.extraCheckouts ?? []).length > 0 ||
            (thread.additionalDirectories ?? []).length > 0
          )
            return yield* refuse(NOT_MOVABLE);
          // Only off a machine that is gone: a thread is never taken from one that is at work.
          const { relocate } = runtimes;
          if (hosts === undefined || machines === undefined || relocate === undefined)
            return yield* refuse(NOT_PLACED_HERE);
          // Asked afresh each time it is run.
          const away = Effect.suspend(() => hosts.get(from)).pipe(
            Effect.as(false),
            Effect.orElseSucceed(() => true),
          );
          if (!(yield* away)) return yield* refuse(MACHINE_STILL_THERE);
          // Whose the thread is goes with the machine it is on (`host/ownership.ts`): it moves only
          // to a machine of the same owner (`keepsOwner`), and of the same purpose, so neither it
          // nor its orchestration changes hands. The runtimes hold to the owner as well.
          const source = machines.get(from);
          if (source === undefined) return yield* refuse(OWNER_UNKNOWN);
          const target = machines.get(to);
          const ownerOf = (id: HostId) =>
            stringField((id === from ? source : id === to ? target : undefined) ?? {}, "owner");
          if (
            target === undefined ||
            !keepsOwner(ownerOf, thread, { hostId: to }) ||
            !sameOwner(ownerOf, checkout, { hostId: to }) ||
            stringField(source, "onDemand") !== stringField(target, "onDemand")
          )
            return yield* refuse(NOT_THE_THREADS_OWNER);
          let files: ReadonlyArray<ProfileFile> = [];
          if (value !== undefined) {
            const decoded = decodeThreadProfile(value);
            if (!decoded.ok)
              return yield* refuse(`That profile can't be applied. ${decoded.problems.join(" ")}`);
            if (!sameValue(profileBindingOf(decoded.profile), thread.profile))
              return yield* refuse("That isn't the profile the thread was started from.");
            files = profileFilesOf(decoded.profile);
          }
          const places = yield* placesOn(to);
          // Fenced in the runtime (`relocate`): from here until the thread is placed on `to`, no
          // send, turn or session starts on it; any session of it stops, an idle one or one only
          // opening for a message, which goes back to its queue; and the placement changes only if
          // nothing started meanwhile. Once it lets go, the queue goes on, on the new machine.
          let made = false;
          const prepare = Effect.gen(function* () {
            // A folder a failed move left there is this thread's and nobody else's: made anew.
            yield* places.remove(threadId);
            const { path } = yield* places.make(threadId, files);
            made = true;
            // The same path, so the thread's records hold.
            if (path !== checkout.path)
              return yield* refuse(
                "That machine keeps thread folders at another path, so the thread can't move to it.",
              );
            // Asked again just before the thread moves: the old machine may have come back while
            // the folder was made, and then the thread stays, and what was made goes.
            if (!(yield* away)) return yield* refuse(MACHINE_STILL_THERE);
            return { ...checkout, hostId: to };
          });
          const moved = yield* relocate(threadId, {
            from: checkout,
            prepare,
            // Told the machine is gone for good: a turn it took with it ends, and the thread moves.
            ...(options.lost === true ? { endWork: true } : {}),
          }).pipe(
            Effect.tapError(() => (made ? places.remove(threadId) : Effect.void)),
            Effect.mapError((error) =>
              error._tag === "ThreadNotFound"
                ? refuse(NOT_MOVABLE)
                : error.message === "the thread is at work"
                  ? refuse(THREAD_AT_WORK)
                  : error,
            ),
          );
          yield* Effect.logInfo("a thread was moved to another machine").pipe(
            Effect.annotateLogs({ threadId, from, to }),
          );
          return { thread: moved, moved: true };
        }),
      );
    });

  return { start, startOne, moveOne, waitOne, expireWaits };
};

/** Where a thread that waits for its machine is said to be: a folder of its own, on no machine. */
const awaitedFolder = (threadId: ThreadId): string => `/${HOST_THREADS_DIR}/${threadId}`;

/** Whether `checkout` is a thread's own folder on a joined machine: `<clones>/.threads/<id>`. */
const ownFolder = (checkout: Thread["checkout"], threadId: ThreadId): boolean => {
  if (checkout.kind !== "main" || checkout.hostId === undefined) return false;
  const parts = checkout.path.split(/[\\/]/);
  return parts.at(-1) === threadId && parts.at(-2) === HOST_THREADS_DIR;
};

/** A record's string field, where it has one: a machine's `owner` or `onDemand`, say. */
const stringField = (record: object, field: string): string | undefined => {
  const value: unknown = Reflect.get(record, field);
  return typeof value === "string" ? value : undefined;
};

/** Two decoded values, alike whatever order their keys were written in. */
const sameValue = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((each, index) => sameValue(each, b[index]))
    );
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const left = Object.entries(a).filter(([, v]) => v !== undefined);
    const right = new Map(Object.entries(b).filter(([, v]) => v !== undefined));
    return (
      left.length === right.size &&
      left.every(([key, v]) => right.has(key) && sameValue(v, right.get(key)))
    );
  }
  return a === b;
};

export type ProfileStarter = ReturnType<typeof makeProfileStarter>;
