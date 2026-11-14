// The acceptance test for a thread started before its machine: started with `machine: "later"`,
// it is stored and shown as waiting, what is sent to it waits in its queue across a restart, and
// naming a machine (`moveOne`) makes its folder there, opens its session and sends the queue
// once. Over the real store and runtime on the fake agent, with stubs of the machines' hosts.
import { describe, expect, it } from "@effect/vitest";
import {
  applySettingsPatch,
  AWAITED_HOST_ID,
  HostId,
  HostUnavailable,
  type ProfileFile,
  ThreadId,
  type ThreadProfile,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActingPerson } from "../embedding/person.ts";
import { mayPlaceAwaited, mayReachThread, RoutedFor } from "../host/ownership.ts";
import type { HostThreadPlaces } from "../host/thread-places.ts";
import type { WorkerHost } from "../host/worker-host.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { CheckoutService, TurnHooks } from "../runtime/hooks.ts";
import { AWAITS_MACHINE } from "../runtime/runtime-state.ts";
import { makeRuntimeTestLayer, TEST_CONFIG, waitFor } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import {
  AWAITED_FOR_MS,
  makeProfileStarter,
  NO_MACHINE_CAME,
  NOT_THE_THREADS_OWNER,
  NOT_WAITING,
  NOW_OR_LATER,
  PROFILES_OFF,
  REPOSITORIES_NEED_A_MACHINE,
  STARTED_BY_NEEDS_LATER,
  WAITS_TO_BE_NAMED,
} from "./start.ts";

const MACHINE = HostId.make("m-0123456789abcdef01234567");
const OTHER = HostId.make("m-89abcdef0123456789abcdef");
const ID = ThreadId.make("0b6c1d1e-6a39-4c8a-9a4e-6f2b8c1d2e3f");
const FIRST = "Draft the release notes.";

const profile = (over: Partial<ThreadProfile> = {}): ThreadProfile => ({
  version: 1,
  name: "Release notes",
  agent: "claude",
  charter: "You write release notes.",
  files: [{ path: "AGENTS.md", content: "# House rules\n" }],
  model: { model: "fake-model" },
  connectors: {},
  workplace: { kind: "scratch" },
  input: FIRST,
  ...over,
});

const folderOn = (threadId: string) => `/machine/repos/.threads/${threadId}`;

/** The machines as whoever runs them has them: which are online, whose each is, what was made. */
const machinesOf = (
  options: {
    readonly online?: ReadonlyArray<HostId>;
    readonly records?: Readonly<Record<string, object | undefined>>;
    /** Run as a folder is made on a machine: a crash, say. */
    readonly whileMaking?: Effect.Effect<void>;
  } = {},
) => {
  const calls: Array<string> = [];
  const made: Array<ReadonlyArray<ProfileFile>> = [];
  const places: HostThreadPlaces = {
    make: (threadId, files) =>
      Effect.gen(function* () {
        calls.push(`make ${threadId}`);
        made.push(files);
        if (options.whileMaking !== undefined) yield* options.whileMaking;
        return { path: folderOn(threadId) };
      }),
    lay: () => Effect.die("not laid"),
    remove: (threadId) => Effect.sync(() => void calls.push(`remove ${threadId}`)),
  };
  const online = new Set(options.online ?? [MACHINE, OTHER]);
  return { calls, made, places, online, records: options.records };
};

/** A server over the database at `file`, as one process has it; another over it is a restart. */
const serverAt = (file: string, dataDir: string) =>
  makeRuntimeTestLayer(
    TurnHooks.layerNoop,
    CheckoutService.layerNoGit,
    { ...TEST_CONFIG, dataDir },
    undefined,
    ThreadStore.layerSqlite(file),
  );

/** The starter of the server in scope, over `machines`. */
const starterOver = (machines: ReturnType<typeof machinesOf>, dataDir: string) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const runtimes = yield* ThreadRuntimes;
    return makeProfileStarter({
      store,
      runtimes,
      dataDir,
      machines: {
        get: (id) =>
          machines.records !== undefined && id in machines.records
            ? machines.records[id]
            : { id, name: id },
      },
      hosts: {
        get: (id) =>
          machines.online.has(id)
            ? Effect.succeed({
                id,
                name: id,
                threadPlaces: machines.places,
              } as unknown as WorkerHost)
            : Effect.fail(new HostUnavailable({ hostId: id, message: `No machine "${id}".` })),
      },
    });
  });

const turnOn = Effect.gen(function* () {
  const store = yield* ThreadStore;
  yield* store.updateSettings(
    (settings) => applySettingsPatch(settings, { experimental: { embedding: true } }),
    [["experimental", "embedding"]],
  );
});

/** What a server does as it starts: sends what the run before it left queued. */
const boot = Effect.gen(function* () {
  yield* (yield* ThreadRuntimes).sendQueuedAtBoot;
});

/** A data folder and a database file of a test's own, removed when it ends. */
const workspace = Effect.gen(function* () {
  const dir = mkdtempSync(join(tmpdir(), "gram-awaiting-"));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );
  return { dataDir: join(dir, "data"), file: join(dir, "gram.db"), dir };
});

/** What a crash leaves: the database as it stands now, for a server booted from the copy. */
const crashCopy = (file: string, to: string) =>
  Effect.sync(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(file + suffix)) copyFileSync(file + suffix, to + suffix);
    }
  });

/** The user's messages of `threadId` in the transcript, with who sent each. */
const typed = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return (yield* store.listMessages(threadId))
      .filter((message) => message.role === "user")
      .map((message) => ({
        text: message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
        sentBy: message.metadata?.sentBy,
      }));
  });

/** Every input any session of `threadId` was sent, in order. */
const sentTo = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const fake = yield* FakeAgentControl;
    return fake.sessions
      .filter((session) => session.options.threadId === threadId)
      .flatMap((session) => session.sent.map((input) => input.text));
  });

const sessionWith = (threadId: ThreadId, count: number) =>
  Effect.gen(function* () {
    const fake = yield* FakeAgentControl;
    return yield* waitFor(
      `${count} sent`,
      Effect.sync(() => {
        const session = fake.sessions.findLast((each) => each.options.threadId === threadId);
        return session !== undefined && session.sent.length === count && session;
      }),
    );
  });

describe("a thread started before its machine", () => {
  it.effect("answers a thread at once, waiting, with its message queued as its starter's", () =>
    Effect.gen(function* () {
      const { dataDir, file } = yield* workspace;
      const machines = machinesOf();
      yield* Effect.gen(function* () {
        yield* turnOn;
        const store = yield* ThreadStore;
        const runtimes = yield* ThreadRuntimes;
        const fake = yield* FakeAgentControl;
        const starter = yield* starterOver(machines, dataDir);
        const { thread, created } = yield* starter.startOne(profile(), {
          threadId: ID,
          machine: "later",
          startedBy: "ada",
        });
        expect(created).toBe(true);
        expect(thread.id).toBe(ID);
        expect(thread.title).toBe("Release notes");
        // Waiting, on no machine, and nothing made anywhere.
        expect(thread.awaitingMachine).toEqual({ since: 0, startedBy: "ada" });
        expect(thread.checkout.hostId).toBe(AWAITED_HOST_ID);
        expect(machines.calls).toEqual([]);
        expect(fake.sessions).toHaveLength(0);
        expect(yield* runtimes.status(ID)).toBe("cold");
        // The message is kept where a restart keeps it, as its starter's.
        const queue = yield* store.listQueue(ID);
        expect(queue.map((item) => [item.input.text, item.actor])).toEqual([
          [FIRST, { person: "ada" }],
        ]);
        // A reader of the thread's summary sees both.
        const summary = yield* runtimes.summaryOf(ID);
        expect(summary?.thread.awaitingMachine?.startedBy).toBe("ada");
        expect(summary?.queue.map((item) => item.input.text)).toEqual([FIRST]);

        // Asked again, it is the same thread, still waiting; naming a machine in a start is not
        // how it gets one.
        const again = yield* starter.startOne(profile(), { threadId: ID, machine: "later" });
        expect(again.created).toBe(false);
        expect(again.thread.awaitingMachine).toBeDefined();
        expect(
          (yield* starter.startOne(profile(), { threadId: ID, on: MACHINE }).pipe(Effect.flip))
            .message,
        ).toBe(WAITS_TO_BE_NAMED);

        // Nothing opens a session for it meanwhile, and what is sent to it waits too.
        expect((yield* runtimes.startSession(ID).pipe(Effect.flip)).message).toBe(AWAITS_MACHINE);
        const more = yield* runtimes
          .send(ID, { text: "And keep it short." })
          .pipe(Effect.provideService(ActingPerson, "ada"));
        expect(more.queued).toBe(true);
        expect(fake.sessions).toHaveLength(0);
        expect(yield* runtimes.status(ID)).toBe("cold");
        expect(yield* typed(ID)).toEqual([]);
      }).pipe(Effect.provide(serverAt(file, dataDir)));
    }),
  );

  it.effect(
    "keeps the thread and its queue across a restart, and sends the queue once when named",
    () =>
      Effect.gen(function* () {
        const { dataDir, file } = yield* workspace;
        const machines = machinesOf();
        yield* Effect.gen(function* () {
          yield* turnOn;
          const starter = yield* starterOver(machines, dataDir);
          yield* starter.startOne(profile(), { threadId: ID, machine: "later", startedBy: "ada" });
        }).pipe(Effect.provide(serverAt(file, dataDir)));

        yield* Effect.gen(function* () {
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          const fake = yield* FakeAgentControl;
          yield* boot;
          // The restart sent nothing: the thread still waits, with its message.
          const waiting = yield* store.getThread(ID);
          expect(waiting.awaitingMachine?.startedBy).toBe("ada");
          expect((yield* store.listQueue(ID)).map((item) => item.input.text)).toEqual([FIRST]);
          expect(fake.sessions).toHaveLength(0);

          const starter = yield* starterOver(machines, dataDir);
          const { thread, moved } = yield* starter.moveOne(ID, MACHINE, profile());
          expect(moved).toBe(true);
          expect(thread.awaitingMachine).toBeUndefined();
          expect(thread.checkout).toEqual({ kind: "main", path: folderOn(ID), hostId: MACHINE });
          // Its folder was made there with the profile's files, after anything left of an
          // earlier try.
          expect(machines.calls).toEqual([`remove ${ID}`, `make ${ID}`]);
          expect(machines.made).toEqual([[{ path: "AGENTS.md", content: "# House rules\n" }]]);
          // The session opened in it, and took the message.
          const session = yield* sessionWith(ID, 1);
          expect(session.options.cwd).toBe(folderOn(ID));
          expect(session.sent[0]?.text).toBe(FIRST);
          expect(yield* typed(ID)).toEqual([{ text: FIRST, sentBy: "ada" }]);
          expect(yield* store.listQueue(ID)).toEqual([]);

          // Named again, and by two calls at once: it is there already, and nothing more is
          // made or sent.
          const again = yield* Effect.all(
            [starter.moveOne(ID, MACHINE, profile()), starter.moveOne(ID, MACHINE, profile())],
            { concurrency: "unbounded" },
          );
          expect(again.map((each) => each.moved)).toEqual([false, false]);
          yield* session.completeTurn();
          yield* waitFor("idle", runtimes.status(ID).pipe(Effect.map((s) => s === "idle")));
          expect(machines.calls).toHaveLength(2);
          expect(yield* sentTo(ID)).toEqual([FIRST]);
          expect(yield* typed(ID)).toEqual([{ text: FIRST, sentBy: "ada" }]);
          expect((yield* store.getThread(ID)).awaitingMachine).toBeUndefined();
        }).pipe(Effect.provide(serverAt(file, dataDir)));
      }),
  );

  it.effect("places it once when two calls name its machine at the same moment", () =>
    Effect.gen(function* () {
      const { dataDir, file } = yield* workspace;
      const machines = machinesOf();
      yield* Effect.gen(function* () {
        yield* turnOn;
        const starter = yield* starterOver(machines, dataDir);
        yield* starter.startOne(profile(), { threadId: ID, machine: "later" });
        // Not with another profile than it was started from: it goes on waiting.
        expect(
          (yield* starter
            .moveOne(ID, MACHINE, profile({ charter: "You do whatever is asked." }))
            .pipe(Effect.flip)).message,
        ).toContain("isn't the profile");
        expect(machines.calls).toEqual([]);
        const named = yield* Effect.all(
          [starter.moveOne(ID, MACHINE, profile()), starter.moveOne(ID, MACHINE, profile())],
          { concurrency: "unbounded" },
        );
        expect(named.map((each) => each.moved).toSorted()).toEqual([false, true]);
        expect(machines.calls).toEqual([`remove ${ID}`, `make ${ID}`]);
        yield* sessionWith(ID, 1);
        expect(yield* sentTo(ID)).toEqual([FIRST]);
        // Named for another machine once it is on one: it doesn't move off a machine that is
        // there, as any thread doesn't.
        expect((yield* starter.moveOne(ID, OTHER, profile()).pipe(Effect.flip)).message).toContain(
          "online",
        );
      }).pipe(Effect.provide(serverAt(file, dataDir)));
    }),
  );

  it.effect("sends the queue once when a restart cuts the naming short, before or after", () =>
    Effect.gen(function* () {
      const { dataDir, file, dir } = yield* workspace;
      const before = join(dir, "before.db");
      const after = join(dir, "after.db");
      yield* Effect.gen(function* () {
        yield* turnOn;
        const fake = yield* FakeAgentControl;
        // The first server stops while the folder is being made, and again once the thread is
        // placed, before its session is up.
        const machines = machinesOf({ whileMaking: crashCopy(file, before) });
        const starter = yield* starterOver(machines, dataDir);
        yield* starter.startOne(profile(), { threadId: ID, machine: "later", startedBy: "ada" });
        yield* fake.setOpenDelay("1 hour");
        yield* starter.moveOne(ID, MACHINE, profile());
        yield* crashCopy(file, after);
        expect(yield* sentTo(ID)).toEqual([]);
      }).pipe(Effect.provide(serverAt(file, dataDir)));

      // Cut short before it was placed: it still waits with its queue, and is named again.
      yield* Effect.gen(function* () {
        const store = yield* ThreadStore;
        const fake = yield* FakeAgentControl;
        yield* boot;
        expect((yield* store.getThread(ID)).awaitingMachine).toBeDefined();
        expect(fake.sessions).toHaveLength(0);
        const machines = machinesOf();
        const starter = yield* starterOver(machines, dataDir);
        expect((yield* starter.moveOne(ID, MACHINE, profile())).moved).toBe(true);
        // What the first try left of the folder went first.
        expect(machines.calls).toEqual([`remove ${ID}`, `make ${ID}`]);
        yield* sessionWith(ID, 1);
        expect(yield* sentTo(ID)).toEqual([FIRST]);
        expect(yield* typed(ID)).toEqual([{ text: FIRST, sentBy: "ada" }]);
      }).pipe(Effect.provide(serverAt(before, dataDir)));

      // Cut short after it was placed: the start sends what it found queued, on that machine,
      // and a naming asked for again finds it there.
      yield* Effect.gen(function* () {
        const store = yield* ThreadStore;
        yield* boot;
        expect((yield* store.getThread(ID)).checkout.hostId).toBe(MACHINE);
        const session = yield* sessionWith(ID, 1);
        expect(session.options.cwd).toBe(folderOn(ID));
        const machines = machinesOf();
        const starter = yield* starterOver(machines, dataDir);
        expect((yield* starter.moveOne(ID, MACHINE, profile())).moved).toBe(false);
        expect(machines.calls).toEqual([]);
        expect(yield* sentTo(ID)).toEqual([FIRST]);
        expect(yield* typed(ID)).toEqual([{ text: FIRST, sentBy: "ada" }]);
      }).pipe(Effect.provide(serverAt(after, dataDir)));
    }),
  );

  it.effect("opens its session to wait when it was started with no message", () =>
    Effect.gen(function* () {
      const { dataDir, file } = yield* workspace;
      const machines = machinesOf();
      yield* Effect.gen(function* () {
        yield* turnOn;
        const store = yield* ThreadStore;
        const runtimes = yield* ThreadRuntimes;
        const fake = yield* FakeAgentControl;
        const starter = yield* starterOver(machines, dataDir);
        const { input: _input, ...silent } = profile();
        yield* starter.startOne(silent, { threadId: ID, machine: "later" });
        expect(yield* store.listQueue(ID)).toEqual([]);
        expect(fake.sessions).toHaveLength(0);
        // With no profile given, its folder is made empty.
        yield* starter.moveOne(ID, MACHINE);
        expect(machines.made).toEqual([[]]);
        yield* waitFor("idle", runtimes.status(ID).pipe(Effect.map((s) => s === "idle")));
        expect((yield* fake.latest(ID)).options.cwd).toBe(folderOn(ID));
        expect(yield* sentTo(ID)).toEqual([]);
      }).pipe(Effect.provide(serverAt(file, dataDir)));
    }),
  );

  it.effect("refuses a workplace of repositories, and a start it can't make sense of", () =>
    Effect.gen(function* () {
      const { dataDir, file } = yield* workspace;
      const machines = machinesOf();
      yield* Effect.gen(function* () {
        yield* turnOn;
        const store = yield* ThreadStore;
        const starter = yield* starterOver(machines, dataDir);
        const refused = (value: unknown, options: Parameters<typeof starter.startOne>[1]) =>
          starter.startOne(value, options).pipe(
            Effect.flip,
            Effect.map((error) => error.message),
          );
        expect(
          yield* refused(
            profile({
              workplace: {
                kind: "repositories",
                repositories: [{ url: "https://git.example.test/acme/site.git" }],
              },
            }),
            { threadId: ID, machine: "later" },
          ),
        ).toBe(REPOSITORIES_NEED_A_MACHINE);
        expect(yield* refused(profile(), { threadId: ID, machine: "later", on: MACHINE })).toBe(
          NOW_OR_LATER,
        );
        expect(yield* refused(profile(), { threadId: ID, startedBy: "ada" })).toBe(
          STARTED_BY_NEEDS_LATER,
        );
        expect(
          yield* refused({ ...profile(), sudo: true }, { threadId: ID, machine: "later" }),
        ).toContain("can't be applied");
        // Nothing was made by any of them, here or on a machine.
        expect(yield* store.listThreads).toEqual([]);
        expect(yield* store.listQueue(ID)).toEqual([]);
        expect(machines.calls).toEqual([]);
        // And a thread that doesn't wait has no wait to speak of.
        expect((yield* starter.waitOne(ID).pipe(Effect.flip)).message).toBe(NOT_WAITING);
      }).pipe(Effect.provide(serverAt(file, dataDir)));
    }),
  );

  it.effect("makes nothing, and says why, while the hosted features are off", () =>
    Effect.gen(function* () {
      const { dataDir, file } = yield* workspace;
      const machines = machinesOf();
      yield* Effect.gen(function* () {
        const store = yield* ThreadStore;
        const starter = yield* starterOver(machines, dataDir);
        const off = yield* starter
          .startOne(profile(), { threadId: ID, machine: "later" })
          .pipe(Effect.flip);
        expect(off.message).toBe(PROFILES_OFF);
        expect((yield* starter.waitOne(ID).pipe(Effect.flip)).message).toBe(PROFILES_OFF);
        expect(yield* starter.expireWaits).toBe(0);
        expect(yield* store.listThreads).toEqual([]);
        expect(existsSync(dataDir)).toBe(false);
      }).pipe(Effect.provide(serverAt(file, dataDir)));
    }),
  );

  it.effect(
    "says so when no machine comes, keeps the queue, and is still placed by a later naming",
    () =>
      Effect.gen(function* () {
        const { dataDir, file } = yield* workspace;
        const machines = machinesOf();
        yield* Effect.gen(function* () {
          yield* turnOn;
          const store = yield* ThreadStore;
          const starter = yield* starterOver(machines, dataDir);
          yield* starter.startOne(profile(), { threadId: ID, machine: "later", startedBy: "ada" });
          // Not before it has waited as long as a session waits for a machine.
          yield* TestClock.adjust(AWAITED_FOR_MS - 1);
          expect(yield* starter.expireWaits).toBe(0);
          expect((yield* store.getThread(ID)).awaitingMachine?.failed).toBeUndefined();
          yield* TestClock.adjust(1);
          expect(yield* starter.expireWaits).toBe(1);
          expect((yield* store.getThread(ID)).awaitingMachine).toEqual({
            since: 0,
            startedBy: "ada",
            failed: { at: AWAITED_FOR_MS, message: NO_MACHINE_CAME },
          });
          // Said once, and nothing of the thread is dropped.
          expect(yield* starter.expireWaits).toBe(0);
          expect((yield* store.listQueue(ID)).map((item) => item.input.text)).toEqual([FIRST]);
        }).pipe(Effect.provide(serverAt(file, dataDir)));

        // After a restart it reads the same. Whoever starts the machines tries again, and says
        // when that fails too, in its own words.
        yield* Effect.gen(function* () {
          const store = yield* ThreadStore;
          const fake = yield* FakeAgentControl;
          const starter = yield* starterOver(machines, dataDir);
          yield* boot;
          expect((yield* store.getThread(ID)).awaitingMachine?.failed?.message).toBe(
            NO_MACHINE_CAME,
          );
          expect(fake.sessions).toHaveLength(0);
          yield* TestClock.adjust(AWAITED_FOR_MS + 60_000);
          const now = 2 * AWAITED_FOR_MS + 60_000;
          expect(yield* starter.waitOne(ID)).toEqual({ since: now, startedBy: "ada" });
          expect(yield* starter.expireWaits).toBe(0);
          const failed = yield* starter.waitOne(ID, { failed: "  The machine ran out of disk. " });
          expect(failed.failed).toEqual({ at: now, message: "The machine ran out of disk." });
          expect((yield* store.listQueue(ID)).map((item) => item.input.text)).toEqual([FIRST]);

          // A machine named now still gets the thread and its message, and the failure is gone.
          const { thread, moved } = yield* starter.moveOne(ID, MACHINE, profile());
          expect(moved).toBe(true);
          expect(thread.awaitingMachine).toBeUndefined();
          yield* sessionWith(ID, 1);
          expect(yield* sentTo(ID)).toEqual([FIRST]);
          expect(yield* typed(ID)).toEqual([{ text: FIRST, sentBy: "ada" }]);
        }).pipe(Effect.provide(serverAt(file, dataDir)));
      }),
  );

  it.effect("keeps a refused naming's thread waiting, with its queue", () =>
    Effect.gen(function* () {
      const { dataDir, file } = yield* workspace;
      const machines = machinesOf({
        online: [MACHINE],
        records: { [MACHINE]: { owner: "bob", onDemand: "thread" } },
      });
      yield* Effect.gen(function* () {
        yield* turnOn;
        const store = yield* ThreadStore;
        const fake = yield* FakeAgentControl;
        const starter = yield* starterOver(machines, dataDir);
        yield* starter.startOne(profile(), { threadId: ID, machine: "later", startedBy: "ada" });
        const refusals = [
          // A machine started for someone else than the thread was started by.
          [yield* starter.moveOne(ID, MACHINE, profile()).pipe(Effect.flip), NOT_THE_THREADS_OWNER],
          // A machine that isn't online.
          [yield* starter.moveOne(ID, OTHER, profile()).pipe(Effect.flip), OTHER],
        ] as const;
        for (const [error, words] of refusals) expect(error.message).toContain(words);
        expect(machines.calls).toEqual([]);
        expect(fake.sessions).toHaveLength(0);
        expect((yield* store.getThread(ID)).awaitingMachine?.startedBy).toBe("ada");
        expect((yield* store.listQueue(ID)).map((item) => item.input.text)).toEqual([FIRST]);
      }).pipe(Effect.provide(serverAt(file, dataDir)));
    }),
  );

  it.effect("sends each person's message as theirs when two wrote while it waited", () =>
    Effect.gen(function* () {
      const { dataDir, file } = yield* workspace;
      const machines = machinesOf();
      yield* Effect.gen(function* () {
        yield* turnOn;
        const runtimes = yield* ThreadRuntimes;
        const starter = yield* starterOver(machines, dataDir);
        // Started by no one in particular, so anyone signed in may write to it.
        const { input: _input, ...silent } = profile();
        yield* starter.startOne(silent, { threadId: ID, machine: "later" });
        const as = (person: string, text: string) =>
          runtimes.send(ID, { text }).pipe(Effect.provideService(ActingPerson, person));
        yield* as("ada", "From Ada.");
        yield* as("bob", "From Bob.");
        expect(yield* typed(ID)).toEqual([]);
      }).pipe(Effect.provide(serverAt(file, dataDir)));

      // Named after a restart, by the platform's own call, which is nobody's.
      yield* Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const starter = yield* starterOver(machines, dataDir);
        yield* boot;
        expect(yield* sentTo(ID)).toEqual([]);
        yield* starter.moveOne(ID, MACHINE);
        const first = yield* sessionWith(ID, 1);
        yield* first.completeTurn();
        const second = yield* sessionWith(ID, 2);
        yield* second.completeTurn();
        yield* waitFor("idle", runtimes.status(ID).pipe(Effect.map((s) => s === "idle")));
        expect(yield* sentTo(ID)).toEqual(["From Ada.", "From Bob."]);
        expect(yield* typed(ID)).toEqual([
          { text: "From Ada.", sentBy: "ada" },
          { text: "From Bob.", sentBy: "bob" },
        ]);
      }).pipe(Effect.provide(serverAt(file, dataDir)));
    }),
  );
});

describe("whose a thread is while it waits for its machine", () => {
  const waiting = (startedBy?: string) =>
    ({
      id: ID,
      checkout: { kind: "main", path: `/.threads/${ID}`, hostId: AWAITED_HOST_ID },
      awaitingMachine: { since: 0, ...(startedBy === undefined ? {} : { startedBy }) },
    }) as never;
  const ownerOf = (id: HostId) => (id === MACHINE ? "ada" : id === OTHER ? "bob" : undefined);
  const reaches = (thread: never, person: string | undefined | "server") =>
    mayReachThread(() => Effect.succeed(thread), ownerOf, ID).pipe(
      Effect.provideService(RoutedFor, person === "server" ? undefined : { person }),
    );

  it.effect("is reached only by who it was started by, and by the server itself", () =>
    Effect.gen(function* () {
      expect(yield* reaches(waiting("ada"), "ada")).toBe(true);
      expect(yield* reaches(waiting("ada"), "bob")).toBe(false);
      expect(yield* reaches(waiting("ada"), undefined)).toBe(false);
      expect(yield* reaches(waiting("ada"), "server")).toBe(true);
      // Started by no one in particular: anyone's, as a thread on no one's machine is.
      expect(yield* reaches(waiting(), "bob")).toBe(true);
    }),
  );

  it("is placed on its starter's machine or on no one's, never on someone else's", () => {
    const unowned = HostId.make("m-shared");
    expect(mayPlaceAwaited(ownerOf, waiting("ada"), MACHINE)).toBe(true);
    expect(mayPlaceAwaited(ownerOf, waiting("ada"), unowned)).toBe(true);
    expect(mayPlaceAwaited(ownerOf, waiting("ada"), OTHER)).toBe(false);
    expect(mayPlaceAwaited(ownerOf, waiting(), OTHER)).toBe(true);
  });
});
