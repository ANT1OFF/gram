import {
  AWAITED_HOST_ID,
  type AwaitingMachine,
  decodeThreadProfile,
  embeddingOn,
  InvalidState,
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
  type Checkout,
  orchestratorProfile,
  type ProfileRole,
  WorkspaceId,
} from "@gram/contracts";
import {
  claimsUnowned,
  holderOf,
  keepsOwner,
  mayPlaceAwaited,
  sameOwner,
} from "../host/ownership.ts";
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
import { SUBJECT } from "../embedding/readable-by.ts";
import { readersFor, readersProblem, setReaders } from "../embedding/thread-readers.ts";
import { HOST_THREADS_DIR } from "../host/thread-places.ts";
import { WAKE_WAIT_MS, type WorkerHostsShape } from "../host/worker-host.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { CreateThreadInput, ThreadRuntimesShape } from "../runtime/thread-runtimes-shape.ts";
import { layProfileFiles } from "./lay.ts";
import {
  homeCharter,
  modelOf,
  NO_ORCHESTRATION,
  PROFILE_HOMES_DIR,
  writeHomeProfile,
} from "./home.ts";
import {
  makeOwnFolder,
  NOT_PLACED_HERE,
  PROFILE_THREADS_DIR,
  placesOn as sharedPlacesOn,
} from "./own-folder.ts";
import type { ProfileRepositories } from "./repositories.ts";
import type { OrchestrationShape } from "../orchestration/service/shape.ts";
import { sameValue } from "./same-value.ts";

type StartBase = Pick<
  CreateThreadInput,
  "model" | "mode" | "title" | "kept" | "input" | "profile" | "readableBy"
> & { readonly id: ThreadId };

export { layProfileFiles } from "./lay.ts";

/** What a caller hears while the hosted features are off. */
export const PROFILES_OFF =
  "Starting a thread from a profile is one of the hosted features, which are off here.";

export { NOT_PLACED_HERE, PROFILE_THREADS_DIR } from "./own-folder.ts";

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

/** What a start with its machine named later is told for an orchestrator's profile. */
export const ORCHESTRATOR_NEEDS_A_MACHINE =
  "An orchestrator's profile is started on its machine. Start it once the machine is online, and name it.";

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

const PERSON = /^[\x21-\x7e]{1,128}$/;

/** What a start naming a reader that isn't a subject is told. */
export const NOT_A_READER =
  "Name the person the thread is readable by by their subject: printable, at most 128 characters.";

/** What a start with readers is told where the store can't keep them (a test layer). */
export const READERS_NOT_KEPT = "Readers can't be kept here.";

/** What a start asked for again, naming another reader than the first, is told. */
export const READER_DIFFERS =
  "That thread id is a thread started for another reader, or for every reader.";

/**
 * What a start asked for again is told when the thread under its id wasn't started from the same
 * profile, or for the same person: it is someone else's thread, and this start made nothing.
 */
export const ID_HELD_BY_ANOTHER =
  "That thread id is held by a thread this start didn't make: another profile's, or another person's.";

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
  /** The one person who may see the thread (`Thread.readableBy`), kept for good. */
  readonly readableBy?: string | undefined;
  /**
   * With `readableBy`: who else may read it but never act on it (`Thread.readers`). Only a start
   * that makes the thread sets them; a repeat leaves them as they are.
   */
  readonly readers?: ReadonlyArray<string> | undefined;
}

/** A thread a start answered, and whether that start made it. */
export interface ProfileStarted {
  readonly thread: Thread;
  readonly created: boolean;
}

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
    Partial<Pick<ThreadStoreShape, "listThreads" | "setThreadReaders">>;
  /**
   * With `relocate` where threads can be moved (`moveOne`), and `updateThread` and `startSession`
   * where one can wait for its machine.
   */
  readonly runtimes: Pick<ThreadRuntimesShape, "create" | "close"> &
    Partial<Pick<ThreadRuntimesShape, "relocate" | "updateThread" | "startSession" | "send">>;
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
  /** Where orchestrators are started (`ThreadProfile.role`); absent, a profile can't start one. */
  readonly orchestration?:
    | Pick<OrchestrationShape, "openFromProfile" | "removeWorkspace">
    | undefined;
}

const refuse = (message: string) => new InvalidState({ message });

const SUPPLIED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const makeProfileStarter = ({
  store,
  runtimes,
  dataDir,
  repositories,
  hosts,
  machines,
  orchestration,
}: ProfileStarterDeps) => {
  const placesOn = (hostId: HostId) => sharedPlacesOn(hosts, hostId);

  const starting = makeKeyedLock<ThreadId>();

  const startOne = (
    value: unknown,
    options: ProfileStartOptions = {},
  ): Effect.Effect<ProfileStarted, InvalidState | AgentUnavailable> => {
    const { threadId: asked, on } = options;
    const { readableBy } = options;
    const fresh = (id: ThreadId) =>
      (options.machine === "later"
        ? startAwaiting(value, id, options.startedBy, readableBy)
        : startAs(value, id, on, readableBy)
      ).pipe(
        Effect.flatMap((thread) => withReaders(thread, options.readers)),
        Effect.map((thread) => ({ thread, created: true })),
      );
    if (readableBy !== undefined && !SUBJECT.test(readableBy))
      return Effect.fail(refuse(NOT_A_READER));
    const readersWrong = readersProblem(readableBy, options.readers);
    if (readersWrong !== undefined) return Effect.fail(refuse(readersWrong));
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
            if (on !== undefined && existing.value.awaitingMachine !== undefined)
              return yield* refuse(WAITS_TO_BE_NAMED);
            if (on !== undefined && existing.value.checkout.hostId !== on)
              return yield* refuse(ON_ANOTHER_MACHINE);
            if (existing.value.readableBy !== readableBy) return yield* refuse(READER_DIFFERS);
            const decoded = decodeThreadProfile(value);
            if (
              !decoded.ok ||
              !sameValue(profileBindingOf(decoded.profile), existing.value.profile) ||
              (options.startedBy !== undefined && existing.value.startedBy !== options.startedBy)
            )
              return yield* refuse(ID_HELD_BY_ANOTHER);
            return { thread: existing.value, created: false };
          }
          if ((yield* store.listClosed).some((closed) => closed.thread.id === asked))
            return yield* refuse("The thread with that id was closed.");
          return yield* fresh(asked);
        }),
      );
    });
  };

  const withReaders = (
    thread: Thread,
    readers: ReadonlyArray<string> | undefined,
  ): Effect.Effect<Thread, InvalidState> =>
    Effect.gen(function* () {
      const kept = yield* readersFor(thread.readableBy, readers);
      if (kept.length === 0) return thread;
      const { getThread, listThreads, setThreadReaders } = store;
      if (listThreads === undefined || setThreadReaders === undefined)
        return yield* refuse(READERS_NOT_KEPT);
      yield* setReaders(
        { getThread, listThreads, listClosed: store.listClosed, setThreadReaders },
        thread.id,
        kept,
      );
      return { ...thread, readers: [...kept] };
    });

  const start = (
    value: unknown,
    options: ProfileStartOptions = {},
  ): Effect.Effect<Thread, InvalidState | AgentUnavailable> =>
    startOne(value, options).pipe(Effect.map((started) => started.thread));

  const startAs = (
    value: unknown,
    id: ThreadId,
    on: HostId | undefined,
    readableBy: string | undefined,
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
      if (on === LOCAL_HOST_ID) return yield* refuse(NAME_A_MACHINE);
      if (on !== undefined) yield* placesOn(on);

      const files = profileFilesOf(profile);
      const base: StartBase = {
        id,
        model: modelOf(profile),
        mode: orchestrationMode(settings),
        ...(profile.name === undefined || profile.name.trim() === ""
          ? {}
          : { title: profile.name.trim(), kept: { userNamed: false } }),
        ...(profile.input === undefined ? {} : { input: { text: profile.input } }),
        profile: profileBindingOf(profile),
        ...(readableBy === undefined ? {} : { readableBy }),
      };

      if (workplace.kind === "repositories" && repositories !== undefined) {
        const place = yield* repositories.prepare(id, workplace.repositories, on);
        const checkouts = [place.checkout, ...place.extraCheckouts];
        const made = Effect.gen(function* () {
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
            additionalDirectories: place.extraCheckouts.map((extra) => extra.path),
          });
        });
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

      const hostId =
        on ?? (hosts?.headless === undefined ? undefined : yield* hosts.headless.machine);
      if (orchestratorProfile(profile)) return yield* startOrchestrator(profile, base, hostId);
      const root = join(dataDir, PROFILE_THREADS_DIR);
      return yield* inOwnFolder(id, files, hostId, (checkout) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => mkdir(root, { recursive: true }).catch(() => undefined));
          yield* store.ensureProject({ root, name: PROFILE_THREADS_PROJECT });
          return yield* runtimes.create({ ...base, projectRoot: root, checkout });
        }),
      );
    });

  const inOwnFolder = <E>(
    id: ThreadId,
    files: ReadonlyArray<ProfileFile>,
    hostId: HostId | undefined,
    make: (checkout: Checkout) => Effect.Effect<Thread, E>,
  ): Effect.Effect<Thread, E | InvalidState> =>
    Effect.gen(function* () {
      const folder = yield* makeOwnFolder({ dataDir, hosts }, id, files, hostId);
      return yield* make(folder.checkout).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : runtimes.close(id).pipe(Effect.ignore, Effect.andThen(folder.remove)),
        ),
      );
    });

  const startOrchestrator = (
    profile: ThreadProfile & { readonly role: { readonly kind: "orchestrator" } },
    base: StartBase,
    hostId: HostId | undefined,
  ): Effect.Effect<Thread, InvalidState | AgentUnavailable> =>
    Effect.gen(function* () {
      const send = runtimes.send;
      if (orchestration === undefined || send === undefined) return yield* refuse(NO_ORCHESTRATION);
      const role = profile.role as Extract<ProfileRole, { kind: "orchestrator" }>;
      const id = base.id;
      const home = join(dataDir, PROFILE_HOMES_DIR, id);
      yield* writeHomeProfile(home, profile);
      const { input, model: _model, mode: _mode, title: _title, kept: _kept, ...rest } = base;
      const thread = yield* orchestration
        .openFromProfile({
          workspaceId: Schema.decodeSync(WorkspaceId)(id),
          name: role.workspace.name.trim(),
          projectRoot: home,
          charter: homeCharter(profile),
          model: modelOf(profile),
          create: ({ model, mode, title, workspaceId }) =>
            inOwnFolder(id, profileFilesOf(profile), hostId, (checkout) =>
              runtimes.create({
                ...rest,
                model,
                mode,
                title,
                projectRoot: home,
                checkout,
                role: "orchestrator",
                workspaceId,
                deferOpen: true,
              }),
            ),
        })
        .pipe(
          Effect.catchTag("NotFound", (error) => Effect.fail(refuse(error.message))),
          Effect.onError(() =>
            orchestration
              .removeWorkspace(Schema.decodeSync(WorkspaceId)(id))
              .pipe(
                Effect.ignore,
                Effect.andThen(
                  Effect.promise(() =>
                    rm(home, { recursive: true, force: true }).catch(() => undefined),
                  ),
                ),
              ),
          ),
        );
      if (input !== undefined) {
        yield* send(thread.id, input).pipe(
          Effect.catch((error) => Effect.fail(refuse(error.message))),
        );
      }
      return thread;
    });

  const startAwaiting = (
    value: unknown,
    id: ThreadId,
    startedBy: string | undefined,
    readableBy: string | undefined,
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
      if (orchestratorProfile(profile)) return yield* refuse(ORCHESTRATOR_NEEDS_A_MACHINE);
      const gateway = profile.model.gatewayProfile;
      if (gateway !== undefined && !(yield* store.listProfiles).some((p) => p.id === gateway)) {
        return yield* refuse(
          `There is no gateway profile ${gateway} here for the model to run on.`,
        );
      }
      if (hosts === undefined || runtimes.relocate === undefined)
        return yield* refuse(NOT_PLACED_HERE);
      const root = join(dataDir, PROFILE_THREADS_DIR);
      const made = Effect.gen(function* () {
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
          checkout: { kind: "main", path: awaitedFolder(id), hostId: AWAITED_HOST_ID },
          awaitingMachine,
          ...(readableBy === undefined ? {} : { readableBy }),
        });
      });
      return yield* (
        startedBy === undefined ? made : made.pipe(Effect.provideService(ActingPerson, startedBy))
      ).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : runtimes.close(id).pipe(Effect.ignore),
        ),
      );
    });

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
        !mayPlaceAwaited(
          Object.assign((id: HostId) => (id === to ? holderOfRecord(to, target) : undefined), {
            personOf: (id: HostId) => (id === to ? personOfRecord(target) : undefined),
          }),
          thread,
          to,
        )
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
        yield* places.remove(threadId);
        const { path } = yield* places.make(threadId, files);
        made = true;
        return { kind: "main" as const, path, hostId: to };
      });
      const placed = yield* relocate(threadId, { from: thread.checkout, prepare }).pipe(
        Effect.tapError(() => (made ? places.remove(threadId) : Effect.void)),
        Effect.mapError((error) => (error._tag === "ThreadNotFound" ? refuse(NOT_MOVABLE) : error)),
      );
      if (runtimes.startSession !== undefined)
        yield* runtimes.startSession(threadId).pipe(Effect.ignore);
      yield* Effect.logInfo("a thread that waited for its machine was placed").pipe(
        Effect.annotateLogs({ threadId, to }),
      );
      return { thread: placed, moved: true };
    });

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
          const { relocate } = runtimes;
          if (hosts === undefined || machines === undefined || relocate === undefined)
            return yield* refuse(NOT_PLACED_HERE);
          const away = Effect.suspend(() => hosts.get(from)).pipe(
            Effect.as(false),
            Effect.orElseSucceed(() => true),
          );
          if (!(yield* away)) return yield* refuse(MACHINE_STILL_THERE);
          const source = machines.get(from);
          if (source === undefined) return yield* refuse(OWNER_UNKNOWN);
          const target = machines.get(to);
          const ownerOf = (id: HostId) =>
            id === from
              ? holderOfRecord(from, source)
              : id === to && target !== undefined
                ? holderOfRecord(to, target)
                : undefined;
          const keeps =
            claimsUnowned(ownerOf, from, to) ||
            (keepsOwner(ownerOf, thread, { hostId: to }) &&
              sameOwner(ownerOf, checkout, { hostId: to }));
          if (
            target === undefined ||
            !keeps ||
            !sameKind(stringField(source, "onDemand"), stringField(target, "onDemand"))
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
            yield* places.remove(threadId);
            const { path } = yield* places.make(threadId, files);
            made = true;
            if (path !== checkout.path)
              return yield* refuse(
                "That machine keeps thread folders at another path, so the thread can't move to it.",
              );
            if (!(yield* away)) return yield* refuse(MACHINE_STILL_THERE);
            return { ...checkout, hostId: to };
          });
          const moved = yield* relocate(threadId, {
            from: checkout,
            prepare,
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

const awaitedFolder = (threadId: ThreadId): string => `/${HOST_THREADS_DIR}/${threadId}`;

const ownFolder = (checkout: Thread["checkout"], threadId: ThreadId): boolean => {
  if (checkout.kind !== "main" || checkout.hostId === undefined) return false;
  const parts = checkout.path.split(/[\\/]/);
  return parts.at(-1) === threadId && parts.at(-2) === HOST_THREADS_DIR;
};

const sameKind = (from: string | undefined, to: string | undefined): boolean =>
  from === to || (from === undefined && to === "thread");

const holderOfRecord = (id: HostId, record: object): string | undefined =>
  holderOf({
    id,
    owner: stringField(record, "owner"),
    onDemand: stringField(record, "onDemand"),
    via: stringField(record, "via"),
  });

const personOfRecord = (record: object): string | undefined =>
  stringField(record, "owner") === undefined ? undefined : stringField(record, "person");

const stringField = (record: object, field: string): string | undefined => {
  const value: unknown = Reflect.get(record, field);
  return typeof value === "string" ? value : undefined;
};

export type ProfileStarter = ReturnType<typeof makeProfileStarter>;
