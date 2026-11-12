// Moving a thread started from a profile onto another joined machine, once the machine it was on
// has gone away for good (`ProfileStarter.moveOne`). Over stubs of the machines' hosts and the
// runtime; how a waiting session follows the move is in `host/placed-move.test.ts`.
import { describe, expect, it } from "@effect/vitest";
import {
  applySettingsPatch,
  InvalidState,
  DEFAULT_SETTINGS,
  HostId,
  HostUnavailable,
  LOCAL_HOST_ID,
  profileBindingOf,
  type ProfileFile,
  type Thread,
  ThreadId,
  ThreadNotFound,
  type ThreadProfile,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostThreadPlaces } from "../host/thread-places.ts";
import type { WorkerHost } from "../host/worker-host.ts";
import {
  MACHINE_STILL_THERE,
  makeProfileStarter,
  NOT_MOVABLE,
  NOT_THE_THREADS_OWNER,
  OWNER_UNKNOWN,
  THREAD_AT_WORK,
} from "./start.ts";

const GONE = HostId.make("machine-gone");
const NEXT = HostId.make("machine-next");
const ID = ThreadId.make("0b6c1d1e-6a39-4c8a-9a4e-6f2b8c1d2e3f");
const ON = applySettingsPatch(DEFAULT_SETTINGS, { experimental: { embedding: true } });
const OFF = DEFAULT_SETTINGS;

const profile = (over: Partial<ThreadProfile> = {}): ThreadProfile => ({
  version: 1,
  agent: "claude",
  charter: "You answer questions about the release.",
  files: [{ path: "AGENTS.md", content: "# House rules\n" }],
  model: { model: "fake-model" },
  connectors: {},
  workplace: { kind: "none" },
  ...over,
});

const folder = (threadId: string, root = "/sandbox/repos") => `${root}/.threads/${threadId}`;

const placedThread = (over: Partial<Thread> = {}): Thread =>
  ({
    id: ID,
    checkout: { kind: "main", path: folder(ID), hostId: GONE },
    profile: profileBindingOf(profile()),
    ...over,
  }) as Thread;

const setup = (
  options: {
    readonly thread?: Thread | undefined;
    readonly online?: ReadonlyArray<HostId>;
    readonly root?: string;
    readonly settings?: typeof ON;
    readonly closed?: boolean;
    /** Each machine's record, as #475's on-demand hosts carry their owner. Absent: unowned. */
    readonly records?: Readonly<Record<string, object | undefined>>;
    /** What putting the thread's session to rest answers, and the thread's status then. */
    readonly rest?: "rested" | "none" | "working";
    readonly status?: "starting" | "running" | "idle";
    /** Called as the folder is made on the target: a machine coming back, say. */
    readonly whileMaking?: () => void;
  } = {},
) => {
  const dataDir = mkdtempSync(join(tmpdir(), "gram-profile-move-"));
  let stored =
    options.thread === undefined && "thread" in options
      ? undefined
      : (options.thread ?? placedThread());
  const calls: Array<string> = [];
  const made: Array<{ readonly threadId: ThreadId; readonly files: ReadonlyArray<ProfileFile> }> =
    [];
  const places: HostThreadPlaces = {
    make: (threadId, files) =>
      Effect.sync(() => {
        calls.push(`make ${threadId}`);
        made.push({ threadId, files });
        options.whileMaking?.();
        return { path: folder(threadId, options.root) };
      }),
    lay: () => Effect.die("not laid"),
    remove: (threadId) => Effect.sync(() => void calls.push(`remove ${threadId}`)),
  };
  const online = new Set(options.online ?? [NEXT]);
  const starter = makeProfileStarter({
    store: {
      getSettings: Effect.succeed(options.settings ?? ON),
      listProfiles: Effect.succeed([]),
      ensureProject: () => Effect.void as never,
      getThread: (threadId) =>
        stored === undefined || stored.id !== threadId
          ? Effect.fail(new ThreadNotFound({ threadId }))
          : Effect.succeed(stored),
      listClosed: Effect.succeed(
        options.closed === true ? [{ thread: placedThread() } as never] : [],
      ),
    },
    runtimes: {
      create: () => Effect.die("not created") as never,
      close: () => Effect.die("not closed") as never,
      // As the runtime's fence does (its own tests are in `runtime/thread-runtimes.test.ts`):
      // a thread at work is refused; any session stops; the placement changes after `prepare`;
      // the queue goes on once it lets go, whether or not it moved.
      relocate: (threadId, plan) =>
        Effect.gen(function* () {
          if (options.rest === "working" && options.status !== "starting")
            return yield* new InvalidState({ message: "the thread is at work", threadId });
          calls.push(`stop ${threadId}`);
          return yield* Effect.gen(function* () {
            const checkout = yield* plan.prepare;
            calls.push(`move ${threadId} ${checkout.hostId}`);
            const current = stored;
            if (current === undefined) return yield* new ThreadNotFound({ threadId });
            stored = { ...current, checkout };
            return stored;
          }).pipe(Effect.ensuring(Effect.sync(() => void calls.push(`release ${threadId}`))));
        }),
    },
    dataDir,
    machines: {
      get: (id) =>
        options.records !== undefined && id in options.records
          ? options.records[id]
          : { id, name: id },
    },
    hosts: {
      get: (id) =>
        online.has(id)
          ? Effect.succeed({ id, name: id, threadPlaces: places } as unknown as WorkerHost)
          : Effect.fail(new HostUnavailable({ hostId: id, message: `No machine "${id}".` })),
    },
  });
  return {
    starter,
    online,
    calls,
    made,
    current: () => stored,
    cleanup: () => rmSync(dataDir, { recursive: true }),
  };
};

describe("moving a profile thread to another machine", () => {
  it.effect("makes its folder again on the new machine, with its files, and places it there", () =>
    Effect.gen(function* () {
      const { starter, calls, made, current, cleanup } = setup();
      yield* Effect.addFinalizer(() => Effect.sync(cleanup));
      const { thread, moved } = yield* starter.moveOne(ID, NEXT, profile());
      expect(moved).toBe(true);
      expect(thread.checkout).toEqual({ kind: "main", path: folder(ID), hostId: NEXT });
      expect(current()?.checkout.hostId).toBe(NEXT);
      // Anything a failed move left there goes first.
      // What waited in its queue goes, on the new machine.
      expect(calls).toEqual([
        `stop ${ID}`,
        `remove ${ID}`,
        `make ${ID}`,
        `move ${ID} ${NEXT}`,
        `release ${ID}`,
      ]);
      expect(made[0]?.files).toEqual([{ path: "AGENTS.md", content: "# House rules\n" }]);
      // Asked again: it is there already, and nothing more is done.
      const again = yield* starter.moveOne(ID, NEXT, profile());
      expect(again.moved).toBe(false);
      expect(calls).toHaveLength(5);
    }),
  );

  it.effect("moves with an empty folder when no profile is given", () =>
    Effect.gen(function* () {
      const { starter, made, cleanup } = setup();
      yield* Effect.addFinalizer(() => Effect.sync(cleanup));
      yield* starter.moveOne(ID, NEXT);
      expect(made[0]?.files).toEqual([]);
    }),
  );

  it.effect("never takes a thread off a machine that is online", () =>
    Effect.gen(function* () {
      const { starter, calls, cleanup } = setup({ online: [GONE, NEXT] });
      yield* Effect.addFinalizer(() => Effect.sync(cleanup));
      const error = yield* starter.moveOne(ID, NEXT, profile()).pipe(Effect.flip);
      expect(error.message).toBe(MACHINE_STILL_THERE);
      expect(calls).toEqual([]);
    }),
  );

  it.effect("refuses a machine that isn't online, and this machine", () =>
    Effect.gen(function* () {
      const { starter, calls, cleanup } = setup({ online: [] });
      yield* Effect.addFinalizer(() => Effect.sync(cleanup));
      const away = yield* starter.moveOne(ID, NEXT).pipe(Effect.flip);
      expect(away.message).toContain(NEXT);
      yield* starter.moveOne(ID, LOCAL_HOST_ID).pipe(Effect.flip);
      expect(calls).toEqual([]);
    }),
  );

  it.effect("refuses another profile than the thread was started from", () =>
    Effect.gen(function* () {
      const { starter, calls, cleanup } = setup();
      yield* Effect.addFinalizer(() => Effect.sync(cleanup));
      const error = yield* starter
        .moveOne(ID, NEXT, profile({ charter: "You do whatever is asked." }))
        .pipe(Effect.flip);
      expect(error.message).toContain("isn't the profile");
      expect(calls).toEqual([]);
    }),
  );

  it.effect("refuses a machine that keeps thread folders elsewhere, leaving nothing there", () =>
    Effect.gen(function* () {
      const { starter, calls, current, cleanup } = setup({ root: "/elsewhere" });
      yield* Effect.addFinalizer(() => Effect.sync(cleanup));
      const error = yield* starter.moveOne(ID, NEXT).pipe(Effect.flip);
      expect(error.message).toContain("another path");
      expect(calls).toEqual([
        `stop ${ID}`,
        `remove ${ID}`,
        `make ${ID}`,
        `release ${ID}`,
        `remove ${ID}`,
      ]);
      expect(current()?.checkout.hostId).toBe(GONE);
    }),
  );

  it.effect("moves only a profile thread in a folder of its own on a joined machine", () =>
    Effect.gen(function* () {
      const refused = (thread: Thread) =>
        Effect.gen(function* () {
          const { starter, calls, cleanup } = setup({ thread });
          yield* Effect.addFinalizer(() => Effect.sync(cleanup));
          const error = yield* starter.moveOne(ID, NEXT).pipe(Effect.flip);
          expect(error.message).toBe(NOT_MOVABLE);
          expect(calls).toEqual([]);
        });
      const { profile: _profile, ...plain } = placedThread();
      // A person's own thread.
      yield* refused(plain as Thread);
      // A worktree of a repository the machine holds.
      yield* refused(
        placedThread({
          checkout: { kind: "worktree", path: folder(ID), hostId: GONE },
        }),
      );
      // A folder that isn't the thread's own.
      yield* refused(
        placedThread({ checkout: { kind: "main", path: "/home/ada/project", hostId: GONE } }),
      );
      // On this machine.
      yield* refused(placedThread({ checkout: { kind: "main", path: folder(ID) } }));
      // With more than its folder.
      yield* refused(
        placedThread({ extraCheckouts: [{ kind: "worktree", path: "/x", hostId: GONE }] }),
      );
    }),
  );

  it.effect("refuses with the hosted features off, and for a closed or unknown thread", () =>
    Effect.gen(function* () {
      const off = setup({ settings: OFF });
      yield* Effect.addFinalizer(() => Effect.sync(off.cleanup));
      expect((yield* off.starter.moveOne(ID, NEXT).pipe(Effect.flip)).message).toContain(
        "hosted features",
      );
      const closed = setup({ thread: undefined, closed: true });
      yield* Effect.addFinalizer(() => Effect.sync(closed.cleanup));
      expect((yield* closed.starter.moveOne(ID, NEXT).pipe(Effect.flip)).message).toContain(
        "closed",
      );
      const unknown = setup({ thread: undefined });
      yield* Effect.addFinalizer(() => Effect.sync(unknown.cleanup));
      expect((yield* unknown.starter.moveOne(ID, NEXT).pipe(Effect.flip)).message).toBe(
        NOT_MOVABLE,
      );
    }),
  );
});

/** A machine's record as #475 keeps one started for a person. */
const owned = (owner: string, onDemand = "thread") => ({ owner, onDemand });

describe("moving a profile thread keeps whose it is (REVIEW-477 1)", () => {
  it.effect("moves between machines started for the same person", () =>
    Effect.gen(function* () {
      const { starter, cleanup } = setup({
        records: { [GONE]: owned("ada"), [NEXT]: owned("ada") },
      });
      yield* Effect.addFinalizer(() => Effect.sync(cleanup));
      expect((yield* starter.moveOne(ID, NEXT)).moved).toBe(true);
    }),
  );

  it.effect("never moves a thread onto another person's machine, or between owned and shared", () =>
    Effect.gen(function* () {
      for (const records of [
        { [GONE]: owned("ada"), [NEXT]: owned("bob") },
        { [GONE]: owned("ada"), [NEXT]: { id: NEXT } },
        { [GONE]: { id: GONE }, [NEXT]: owned("bob") },
        { [GONE]: owned("ada", "thread"), [NEXT]: owned("ada", "personal") },
      ]) {
        const { starter, calls, current, cleanup } = setup({ records });
        yield* Effect.addFinalizer(() => Effect.sync(cleanup));
        const error = yield* starter.moveOne(ID, NEXT).pipe(Effect.flip);
        expect(error.message).toBe(NOT_THE_THREADS_OWNER);
        expect(calls).toEqual([]);
        expect(current()?.checkout.hostId).toBe(GONE);
      }
    }),
  );

  it.effect(
    "refuses when the old machine's record is gone, as whose the thread is can't be told",
    () =>
      Effect.gen(function* () {
        const { starter, calls, cleanup } = setup({ records: { [GONE]: undefined } });
        yield* Effect.addFinalizer(() => Effect.sync(cleanup));
        expect((yield* starter.moveOne(ID, NEXT).pipe(Effect.flip)).message).toBe(OWNER_UNKNOWN);
        expect(calls).toEqual([]);
      }),
  );
});

describe("moving a profile thread leaves nothing of it on the old machine (REVIEW-477 2)", () => {
  it.effect("stays when the old machine comes back while the new folder is made", () =>
    Effect.gen(function* () {
      let back: (() => void) | undefined;
      const { starter, online, calls, current, cleanup } = setup({ whileMaking: () => back?.() });
      back = () => online.add(GONE);
      yield* Effect.addFinalizer(() => Effect.sync(cleanup));
      const error = yield* starter.moveOne(ID, NEXT).pipe(Effect.flip);
      expect(error.message).toBe(MACHINE_STILL_THERE);
      // What was made for it there goes, and the thread is where it was.
      expect(calls).toEqual([
        `stop ${ID}`,
        `remove ${ID}`,
        `make ${ID}`,
        `release ${ID}`,
        `remove ${ID}`,
      ]);
      expect(current()?.checkout.hostId).toBe(GONE);
    }),
  );

  it.effect(
    "refuses a thread at work, and moves one whose session it put to rest or that is only opening",
    () =>
      Effect.gen(function* () {
        const working = setup({ rest: "working", status: "running" });
        yield* Effect.addFinalizer(() => Effect.sync(working.cleanup));
        expect((yield* working.starter.moveOne(ID, NEXT).pipe(Effect.flip)).message).toBe(
          THREAD_AT_WORK,
        );
        expect(working.calls).toEqual([]);
        for (const ready of [
          { rest: "rested" as const },
          { rest: "working" as const, status: "starting" as const },
        ]) {
          const moving = setup(ready);
          yield* Effect.addFinalizer(() => Effect.sync(moving.cleanup));
          expect((yield* moving.starter.moveOne(ID, NEXT)).moved).toBe(true);
          expect(moving.calls[0]).toBe(`stop ${ID}`);
        }
      }),
  );
});
