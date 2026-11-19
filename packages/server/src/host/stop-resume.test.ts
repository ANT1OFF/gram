// What `resumeHost` does about a thread's folder that isn't on the machine's disk: asks the host
// to make it again from what a stop kept, for a folder Gram made from a clone there, and reports
// it missing otherwise. The host's side is `stop.test.ts`'s, with real repositories.

import { describe, expect, it } from "@effect/vitest";
import {
  HostFailed,
  type HostId,
  type HostStopRestored,
  HostUnavailable,
  type SavedDiff,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { makeStopMarks, type StopMarks } from "./stop-marks.ts";
import { awaitedMachines, RESUME_STALLED, restoreGateOf, type WorkerHost } from "./worker-host.ts";
import type { KeepRequest, RestoreRequest } from "./stop.ts";
import { cloneIdentityOf, cloneUrlOf } from "./repos.ts";
import {
  keepThreadWork,
  prepareStop,
  resumeHost,
  resumeOwedMachines,
  savedDiffOf,
  type StopResumeDeps,
} from "./stop-resume.ts";

const MACHINE = "m-1" as HostId;
const URL = "https://git.example.test/acme/widgets.git";
const COMMIT = "a".repeat(40);

const thread = (id: string, checkout: Partial<Thread["checkout"]> & { path: string }) =>
  ({
    id: id as ThreadId,
    checkout: { kind: "worktree", hostId: MACHINE, ...checkout },
  }) as unknown as Thread;

const THREADS = [
  thread("t-worker", {
    path: "/clones/widgets-trees/worker",
    branch: "gram/worker",
    repoRoot: "/clones/widgets",
    cloneIdentity: cloneIdentityOf(URL)!,
  }),
  thread("t-here", { path: "/clones/widgets-trees/here", cloneIdentity: cloneIdentityOf(URL)! }),
  // A folder the user picked there: Gram didn't make it from a clone.
  thread("t-folder", { kind: "main", path: "/home/dev/project" }),
  thread("t-nothing", {
    path: "/clones/widgets-trees/nothing",
    branch: "gram/nothing",
    cloneIdentity: cloneIdentityOf(URL)!,
  }),
  thread("t-refused", {
    path: "/clones/widgets-trees/refused",
    cloneIdentity: cloneIdentityOf(URL)!,
  }),
];

/** A machine whose disk holds only `present`, and what it was asked to put back. */
const machine = (present: ReadonlyArray<string>, restores: boolean) => {
  const asked: Array<RestoreRequest> = [];
  const restore = (request: RestoreRequest) =>
    Effect.suspend((): Effect.Effect<HostStopRestored, HostFailed> => {
      asked.push(request);
      if (request.threadId === "t-nothing")
        return Effect.succeed({ restored: false, note: "Nothing was kept of it at the remote." });
      if (request.threadId === "t-refused")
        return Effect.fail(new HostFailed({ message: "git fetch failed" }));
      return Effect.succeed({ restored: true, commit: COMMIT, uncommitted: true });
    });
  const started: Array<ThreadId> = [];
  const stops = makeStopMarks();
  stops.stopped(MACHINE, ["t-worker" as ThreadId, "t-folder" as ThreadId]);
  const deps = {
    hosts: {
      connection: () =>
        Effect.succeed({
          git: { present: (cwd: string) => Effect.succeed(present.includes(cwd)) },
          stop: restores ? { restore } : {},
        }),
      stops,
    },
    store: { listThreads: Effect.succeed(THREADS) },
    runtimes: {
      startSession: (threadId: ThreadId) => Effect.sync(() => void started.push(threadId)),
    },
  } as unknown as StopResumeDeps;
  return { deps, asked, started };
};

/** A machine's resume state and a session about to open on it, with a host whose disk is `disk`. */
const gated = (stops: StopMarks) =>
  awaitedMachines(
    () => Effect.succeed({ id: MACHINE } as unknown as WorkerHost),
    { machines: { get: () => ({ confirmedAt: 1 }) } as never, stops },
    { getSettings: Effect.succeed({ experimental: { embedding: true } } as never) },
    60 * 60_000,
  );

/** Marks whose clock is the test's: `advance` moves both. */
const clocked = () => {
  let at = 0;
  const stops = makeStopMarks(() => at);
  const advance = (ms: number) =>
    Effect.gen(function* () {
      for (let step = 0; step < ms; step += 1_000) {
        at += 1_000;
        yield* TestClock.adjust("1 second");
      }
    });
  return { stops, advance };
};

describe("resuming a machine on another disk", () => {
  it.effect("has each missing folder Gram made from a clone put back, and opens its session", () =>
    Effect.gen(function* () {
      const { deps, asked, started } = machine(["/clones/widgets-trees/here"], true);
      const resumed = yield* resumeHost(deps, MACHINE, { remote: "mirror" });
      expect(asked).toEqual([
        {
          threadId: "t-worker",
          cwd: "/clones/widgets-trees/worker",
          url: URL,
          branch: "gram/worker",
          remote: "mirror",
        },
        {
          threadId: "t-nothing",
          cwd: "/clones/widgets-trees/nothing",
          url: URL,
          branch: "gram/nothing",
          remote: "mirror",
        },
        { threadId: "t-refused", cwd: "/clones/widgets-trees/refused", url: URL, remote: "mirror" },
      ]);
      expect(resumed.restored).toEqual([
        {
          threadId: "t-worker",
          cwd: "/clones/widgets-trees/worker",
          commit: COMMIT,
          uncommitted: true,
        },
      ]);
      expect(resumed.missing).toEqual([
        { threadId: "t-folder", cwd: "/home/dev/project" },
        {
          threadId: "t-nothing",
          cwd: "/clones/widgets-trees/nothing",
          note: "Nothing was kept of it at the remote.",
        },
      ]);
      // Refused: the folder may be there without its work, so it isn't taken for back.
      expect(resumed.refused).toEqual([
        { threadId: "t-refused", cwd: "/clones/widgets-trees/refused", note: "git fetch failed" },
      ]);
      // The restored thread's session opens again; the one still missing its folder is left.
      expect(started).toEqual(["t-worker"]);
      expect(resumed.reopened).toEqual(["t-worker"]);
      expect(resumed.left).toEqual([
        {
          threadId: "t-folder",
          reason: "Its folder isn't on the machine, and Gram can't put it back there.",
        },
      ]);
    }),
  );

  it.effect("counts a folder made by a resume beside it as there, not missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // A host that makes each folder once: asked again for one that is there, it says so.
        const disk = new Set<string>();
        const restore = (request: RestoreRequest) =>
          Effect.gen(function* () {
            // Cloning takes a while; one made meanwhile is found there at the end.
            yield* Effect.sleep("1 second");
            if (disk.has(request.cwd))
              return { restored: false, note: "Its folder is there already." } as HostStopRestored;
            disk.add(request.cwd);
            return { restored: true, commit: COMMIT } as HostStopRestored;
          });
        const cwd = "/clones/widgets-trees/shared";
        const deps = {
          hosts: {
            connection: () =>
              Effect.succeed({
                git: { present: (at: string) => Effect.sync(() => disk.has(at)) },
                stop: { restore },
              }),
            stops: makeStopMarks(),
          },
          store: {
            // Two threads in one folder.
            listThreads: Effect.succeed([
              thread("t-one", { path: cwd, cloneIdentity: cloneIdentityOf(URL)! }),
              thread("t-two", { path: cwd, cloneIdentity: cloneIdentityOf(URL)! }),
            ]),
          },
          runtimes: { startSession: () => Effect.void },
        } as unknown as StopResumeDeps;
        const resumes = yield* Effect.forkScoped(
          Effect.all([resumeHost(deps, MACHINE), resumeHost(deps, MACHINE)], {
            concurrency: "unbounded",
          }),
        );
        yield* TestClock.adjust("5 seconds");
        const [first, second] = yield* Fiber.join(resumes);
        expect([...first.missing, ...second.missing]).toEqual([]);
        expect([...first.restored, ...second.restored]).toHaveLength(1);
      }),
    ),
  );

  it.effect("puts the folders of a thread a session waits for back first, and says so", () =>
    Effect.gen(function* () {
      const { deps, asked } = machine([], true);
      const hosts = deps.hosts as unknown as { stops: StopMarks };
      const real = hosts.stops;
      const done: Array<string> = [];
      hosts.stops = {
        ...real,
        threadBack: (id: HostId, threadId: ThreadId) => {
          done.push(threadId);
          real.threadBack(id, threadId);
        },
        block: (id: HostId, threadId: ThreadId, reason: string) => {
          done.push(threadId);
          real.block(id, threadId, reason);
        },
      };
      const stops = real;
      stops.awaiting(MACHINE, "t-refused" as ThreadId);
      yield* resumeHost(deps, MACHINE);
      expect(asked[0]?.threadId).toBe("t-refused");
      expect(done[0]).toBe("t-refused");
      expect(done).toEqual(
        expect.arrayContaining(["t-worker", "t-here", "t-nothing", "t-folder", "t-refused"]),
      );
    }),
  );

  it.effect("holds the machine to what the stop said it kept, remembered or given back", () =>
    Effect.gen(function* () {
      const { deps, asked } = machine(["/clones/widgets-trees/here"], true);
      const stops = (deps.hosts as unknown as { stops: ReturnType<typeof makeStopMarks> }).stops;
      // This Gram's own stop: a ref for the worker's folder, pushed to a mirror.
      stops.keep(MACHINE, "t-worker" as ThreadId, "/clones/widgets-trees/worker", {
        commit: COMMIT,
        caughtUp: false,
        remote: "mirror",
        branch: "gram/moved",
      });
      const other = "b".repeat(40);
      yield* resumeHost(deps, MACHINE, {
        kept: [
          // The caller's word for a folder: its branch at the remote held everything.
          {
            threadId: "t-nothing" as ThreadId,
            cwd: "/clones/widgets-trees/nothing",
            commit: other,
            caughtUp: true,
          },
          // Not a commit: nothing to hold the machine to.
          { threadId: "t-refused" as ThreadId, cwd: "/clones/widgets-trees/refused", commit: "x" },
        ],
      });
      expect(asked).toEqual([
        {
          threadId: "t-worker",
          cwd: "/clones/widgets-trees/worker",
          url: URL,
          branch: "gram/moved",
          remote: "mirror",
          commit: COMMIT,
        },
        {
          threadId: "t-nothing",
          cwd: "/clones/widgets-trees/nothing",
          url: URL,
          branch: "gram/nothing",
          commit: other,
          caughtUp: true,
        },
        { threadId: "t-refused", cwd: "/clones/widgets-trees/refused", url: URL },
      ]);
      // Forgotten with the machine.
      stops.forget(MACHINE);
      expect(
        stops.keptOf(MACHINE, "t-worker" as ThreadId, "/clones/widgets-trees/worker"),
      ).toBeUndefined();
    }),
  );

  it.effect("remembers what a stop said it kept, with where and on which branch", () =>
    Effect.gen(function* () {
      const stops = makeStopMarks();
      const worker = "/clones/widgets-trees/worker";
      const nothing = "/clones/widgets-trees/nothing";
      const deps = {
        hosts: {
          connection: () =>
            Effect.succeed({
              stop: {
                cancel: Effect.void,
                prepare: () =>
                  Effect.succeed({
                    idle: true,
                    busy: { turns: 0, terminals: 0, clones: 0, checks: 0 },
                    kept: [
                      {
                        threadId: "t-worker",
                        cwd: worker,
                        ref: "refs/gram/wip/t-worker",
                        commit: COMMIT,
                        branch: "gram/worker",
                        pushed: true,
                      },
                      {
                        threadId: "t-nothing",
                        cwd: nothing,
                        commit: COMMIT,
                        branch: "gram/nothing",
                        pushed: true,
                        caughtUp: true,
                      },
                      // Not pushed: the remote was never said to have it.
                      {
                        threadId: "t-refused",
                        cwd: "/clones/widgets-trees/refused",
                        ref: "refs/gram/wip/t-refused",
                        commit: COMMIT,
                        pushed: false,
                      },
                    ],
                  }),
              },
            }),
          stops,
        },
        store: { listThreads: Effect.succeed(THREADS) },
        runtimes: { restSession: () => Effect.succeed("cold") },
      } as unknown as StopResumeDeps;
      const prepared = yield* prepareStop(deps, MACHINE, { remote: "mirror" });
      expect(prepared.kept.find((kept) => kept.cwd === worker)).toEqual({
        threadId: "t-worker",
        cwd: worker,
        ref: "refs/gram/wip/t-worker",
        commit: COMMIT,
        branch: "gram/worker",
        remote: "mirror",
        pushed: true,
      });
      expect(stops.keptOf(MACHINE, "t-worker" as ThreadId, worker)).toEqual({
        commit: COMMIT,
        caughtUp: false,
        at: 0,
        remote: "mirror",
        branch: "gram/worker",
      });
      expect(stops.keptOf(MACHINE, "t-nothing" as ThreadId, nothing)).toEqual({
        commit: COMMIT,
        caughtUp: true,
        at: 0,
        remote: "mirror",
        branch: "gram/nothing",
      });
      expect(
        stops.keptOf(MACHINE, "t-refused" as ThreadId, "/clones/widgets-trees/refused"),
      ).toBeUndefined();
      // Taken back, the remote still has it.
      stops.cancel(MACHINE);
      expect(stops.keptOf(MACHINE, "t-worker" as ThreadId, worker)).toMatchObject({
        commit: COMMIT,
      });
    }),
  );

  const SAVED: SavedDiff = {
    base: "origin/main",
    uncommitted: true,
    files: [
      {
        path: "src/a.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1 +1,2 @@\n-a\n+b\n+c\n",
        binary: false,
        tooLarge: false,
      },
    ],
  };

  it.effect("keeps a working thread's folders, and a lost machine's resume is held to them", () =>
    Effect.gen(function* () {
      const worker = "/clones/widgets-trees/worker";
      const { deps, asked } = machine([], true);
      const keeps: Array<KeepRequest> = [];
      const connection = yield* deps.hosts.connection(MACHINE);
      const kept = {
        ...connection,
        stop: {
          ...connection.stop,
          keep: (request: KeepRequest) =>
            Effect.sync(() => {
              keeps.push(request);
              return request.checkouts.map((checkout) => ({
                ...checkout,
                ref: `refs/gram/wip/${checkout.threadId}`,
                commit: COMMIT,
                branch: "gram/worker",
                pushed: true,
                saved: SAVED,
              }));
            }),
        },
      };
      const hosts = { ...deps.hosts, connection: () => Effect.succeed(kept) };
      const withKeep = { ...deps, hosts } as unknown as StopResumeDeps;
      // A folder Gram didn't make from a clone isn't asked: nothing could put it back.
      expect(yield* keepThreadWork(withKeep, MACHINE, THREADS[2]!)).toEqual([]);
      expect(keeps).toEqual([]);
      yield* keepThreadWork(withKeep, MACHINE, THREADS[0]!);
      expect(keeps).toEqual([{ checkouts: [{ threadId: "t-worker", cwd: worker }] }]);
      // What the save held stays readable here while the machine is away.
      expect(savedDiffOf(deps.hosts.stops, THREADS[0]!)).toEqual(SAVED);
      expect(savedDiffOf(deps.hosts.stops, THREADS[1]!)).toBeUndefined();
      // The machine is lost with no stop; the one that replaces it is held to what was kept.
      yield* resumeHost(withKeep, MACHINE);
      expect(asked.find((request) => request.cwd === worker)).toMatchObject({
        commit: COMMIT,
        branch: "gram/worker",
      });
    }),
  );

  it.effect("reports them missing, as before, on a host that puts nothing back", () =>
    Effect.gen(function* () {
      const { deps, asked, started } = machine(["/clones/widgets-trees/here"], false);
      const resumed = yield* resumeHost(deps, MACHINE);
      expect(asked).toEqual([]);
      expect(resumed.restored).toEqual([]);
      expect(resumed.missing.map((entry) => entry.threadId)).toEqual([
        "t-worker",
        "t-folder",
        "t-nothing",
        "t-refused",
      ]);
      expect(started).toEqual([]);
    }),
  );

  it.effect("puts the clone itself back though a worktree's restore made its path first", () =>
    Effect.gen(function* () {
      // The orchestrator's folder is the machine's clone; its workers' worktrees are made from it,
      // and a worktree's restore clones the repository there before the orchestrator's turn.
      const clone = "/clones/widgets";
      const disk = new Set<string>();
      const asked: Array<RestoreRequest> = [];
      const restore = (request: RestoreRequest) =>
        Effect.sync((): HostStopRestored => {
          asked.push(request);
          disk.add(clone);
          disk.add(request.cwd);
          return { restored: true, commit: COMMIT };
        });
      const workers = [1, 2, 3, 4, 5].map((n) =>
        thread(`t-w${n}`, {
          path: `/clones/widgets-trees/w${n}`,
          branch: `gram/w${n}`,
          cloneIdentity: cloneIdentityOf(URL)!,
        }),
      );
      const orchestrator = thread("t-orch", {
        kind: "current",
        path: clone,
        branch: "main",
        cloneIdentity: cloneIdentityOf(URL)!,
      } as never);
      const stops = makeStopMarks();
      stops.expect(MACHINE);
      stops.back(MACHINE);
      const deps = {
        hosts: {
          connection: () =>
            Effect.succeed({
              git: { present: (cwd: string) => Effect.sync(() => disk.has(cwd)) },
              stop: { restore },
            }),
          stops,
        },
        store: { listThreads: Effect.succeed([...workers, orchestrator]) },
        runtimes: { startSession: () => Effect.void },
      } as unknown as StopResumeDeps;
      const resumed = yield* resumeHost(deps, MACHINE);
      // Asked of the host though its path was there by its turn: the host decides.
      expect(asked.map((request) => request.cwd)).toContain(clone);
      expect(resumed.restored.map((entry) => entry.threadId)).toContain("t-orch");
      expect(restoreGateOf(stops, MACHINE, "t-orch" as ThreadId)).toBeUndefined();
    }),
  );

  it.effect(
    "asks the host of a folder the machine can't say is there, and never takes it for there",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { deps, asked, started } = machine(
            THREADS.map((each) => each.checkout.path),
            true,
          );
          const hosts = deps.hosts as unknown as {
            connection: () => Effect.Effect<unknown>;
            stops: StopMarks;
          };
          const connection = (yield* hosts.connection()) as { git: object; stop: object };
          // `present` answers yes for every folder, as a host whose read fails does over the wire.
          hosts.connection = () =>
            Effect.succeed({
              ...connection,
              git: { ...connection.git, presence: () => Effect.succeed(undefined) },
            });
          const resuming = yield* Effect.forkScoped(resumeHost(deps, MACHINE));
          yield* TestClock.adjust("10 seconds");
          const resumed = yield* Fiber.join(resuming);
          // Every folder Gram made from a clone is asked of the host, the one it reads as there too.
          expect(asked.map((request) => request.threadId)).toEqual([
            "t-worker",
            "t-here",
            "t-nothing",
            "t-refused",
          ]);
          // One it can't put back nor read is refused, and its thread's session doesn't open.
          expect(resumed.refused).toContainEqual({
            threadId: "t-folder",
            cwd: "/home/dev/project",
            note: "The machine couldn't say whether its folder is there.",
          });
          expect(started).toEqual(["t-worker"]);
          expect(hosts.stops.blocked(MACHINE, "t-folder" as ThreadId)).toMatch(
            /couldn't say whether its folder is there/,
          );
        }),
      ),
  );

  it.effect("holds a session for a restore that takes longer than three minutes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { stops, advance } = clocked();
        stops.stopped(MACHINE, []);
        stops.away(MACHINE);
        stops.back(MACHINE);
        let made = false;
        const cwd = "/clones/widgets-trees/slow";
        const restore = () =>
          Effect.gen(function* () {
            yield* Effect.sleep("12 minutes");
            made = true;
            return { restored: true, commit: COMMIT } as HostStopRestored;
          });
        const deps = {
          hosts: {
            connection: () =>
              Effect.succeed({
                git: { present: () => Effect.sync(() => made) },
                stop: { restore },
              }),
            stops,
          },
          store: {
            listThreads: Effect.succeed([
              thread("t-slow", { path: cwd, cloneIdentity: cloneIdentityOf(URL)! }),
            ]),
          },
          runtimes: { startSession: () => Effect.void },
        } as unknown as StopResumeDeps;
        const resuming = yield* Effect.forkScoped(resumeHost(deps, MACHINE));
        const opening = yield* Effect.forkScoped(gated(stops)(MACHINE, "t-slow" as ThreadId));
        // Well past the three minutes the gate once opened at: still held.
        yield* advance(4 * 60_000);
        expect(opening.pollUnsafe()).toBeUndefined();
        yield* advance(7 * 60_000);
        expect(opening.pollUnsafe()).toBeUndefined();
        expect(made).toBe(false);
        yield* advance(2 * 60_000);
        expect(made).toBe(true);
        expect((yield* Fiber.join(opening)).id).toBe(MACHINE);
        yield* Fiber.join(resuming);
      }),
    ),
  );

  it.effect("tells a waiting session when a resume makes no progress, rather than opening it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { stops, advance } = clocked();
        stops.expect(MACHINE);
        stops.back(MACHINE);
        // Nobody resumes it.
        const opening = yield* Effect.forkScoped(
          Effect.exit(gated(stops)(MACHINE, "t-one" as ThreadId)),
        );
        yield* advance(24 * 60_000);
        expect(opening.pollUnsafe()).toBeUndefined();
        yield* advance(2 * 60_000);
        const exit = yield* Fiber.join(opening);
        expect(exit._tag).toBe("Failure");
        expect(JSON.stringify(exit)).toContain(RESUME_STALLED.slice(0, 40));
        // Given up on, said; a session asked for after that opens as the folders are.
        expect((yield* gated(stops)(MACHINE, "t-one" as ThreadId)).id).toBe(MACHINE);
      }),
    ),
  );

  it.effect("leaves the resume owed when it can't reach the machine", () =>
    Effect.gen(function* () {
      const stops = makeStopMarks();
      stops.expect(MACHINE);
      stops.back(MACHINE);
      const deps = {
        hosts: {
          connection: (hostId: HostId) =>
            Effect.fail(new HostUnavailable({ hostId, message: "That machine is offline." })),
          stops,
        },
        store: { listThreads: Effect.succeed(THREADS) },
        runtimes: { startSession: () => Effect.void },
      } as unknown as StopResumeDeps;
      expect((yield* Effect.flip(resumeHost(deps, MACHINE)))._tag).toBe("HostUnavailable");
      expect(stops.resuming(MACHINE)).toBe(true);
      expect(stops.resumeRunning(MACHINE)).toBe(false);
    }),
  );

  it.effect(
    "is run by this Gram itself for a machine back on another disk, hosted features off",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { deps, asked } = machine([], true);
          const stops = deps.hosts.stops;
          stops.hello(MACHINE, { diskId: "disk-aaaaaaaa" });
          stops.hello(MACHINE, { diskId: "disk-bbbbbbbb" });
          stops.back(MACHINE);
          const watchers: Array<() => void> = [];
          const settings = { experimental: { embedding: false } };
          yield* resumeOwedMachines({
            ...deps,
            hosts: {
              ...deps.hosts,
              machines: { list: () => [{ id: MACHINE, name: "box", confirmedAt: 1 }] } as never,
              watch: (listener: () => void) => {
                watchers.push(listener);
                return () => {};
              },
            },
            settings: { getSettings: Effect.sync(() => settings as never) },
          });
          yield* TestClock.adjust("1 second");
          expect(asked.length).toBeGreaterThan(0);
          expect(stops.owes(MACHINE)).toBe(false);
          // With them on, it is left to whoever starts the machines.
          settings.experimental.embedding = true;
          stops.hello(MACHINE, { diskId: "disk-cccccccc" });
          stops.back(MACHINE);
          asked.length = 0;
          for (const watcher of watchers) watcher();
          yield* TestClock.adjust("2 minutes");
          expect(asked).toEqual([]);
          expect(stops.owes(MACHINE)).toBe(true);
        }),
      ),
  );

  it.effect("keeps a thread whose only folder is missing from opening, and says why", () =>
    Effect.gen(function* () {
      const only = thread("t-lost", { kind: "main", path: "/home/dev/lost" });
      const stops = makeStopMarks();
      stops.stopped(MACHINE, ["t-lost" as ThreadId]);
      stops.away(MACHINE);
      stops.back(MACHINE);
      const started: Array<ThreadId> = [];
      const deps = {
        hosts: {
          connection: () =>
            Effect.succeed({ git: { present: () => Effect.succeed(false) }, stop: {} }),
          stops,
        },
        store: { listThreads: Effect.succeed([only]) },
        runtimes: {
          startSession: (threadId: ThreadId) => Effect.sync(() => void started.push(threadId)),
        },
      } as unknown as StopResumeDeps;
      const resumed = yield* resumeHost(deps, MACHINE);
      expect(resumed.missing).toEqual([{ threadId: "t-lost", cwd: "/home/dev/lost" }]);
      expect(started).toEqual([]);
      expect(stops.isThreadBack(MACHINE, "t-lost" as ThreadId)).toBe(false);
      expect(restoreGateOf(stops, MACHINE, "t-lost" as ThreadId)).toBe("blocked");
      // The resume is over, and still its session doesn't open there: it says why at once.
      const exit = yield* Effect.exit(gated(stops)(MACHINE, "t-lost" as ThreadId));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("Its folder isn't on the machine");
      // Another thread on the machine opens as on any machine.
      expect(restoreGateOf(stops, MACHINE, "t-other" as ThreadId)).toBeUndefined();
    }),
  );

  it.effect(
    "asks again of a folder a resume couldn't put back, and keeps nothing of it at a stop",
    () =>
      Effect.gen(function* () {
        const cwd = "/clones/widgets";
        const own = thread("t-orch", {
          kind: "current",
          path: cwd,
          branch: "main",
          cloneIdentity: cloneIdentityOf(URL)!,
        } as never);
        // The host refuses: a fresh clone's default branch is ahead of the kept work. The plain
        // clone stays at the path.
        let refuse = true;
        const disk = new Set<string>();
        const asked: Array<RestoreRequest> = [];
        const keeps: Array<KeepRequest> = [];
        const restore = (request: RestoreRequest) =>
          Effect.suspend((): Effect.Effect<HostStopRestored, HostFailed> => {
            asked.push(request);
            disk.add(cwd);
            return refuse
              ? Effect.fail(new HostFailed({ message: "main is here already with commits" }))
              : Effect.succeed({ restored: true, commit: COMMIT });
          });
        const stops = makeStopMarks();
        const prepared: Array<ReadonlyArray<unknown>> = [];
        const deps = {
          hosts: {
            connection: () =>
              Effect.succeed({
                git: { present: (at: string) => Effect.sync(() => disk.has(at)) },
                stop: {
                  restore,
                  cancel: Effect.void,
                  keep: (request: KeepRequest) =>
                    Effect.sync(() => {
                      keeps.push(request);
                      return [];
                    }),
                  prepare: (request: { checkouts: ReadonlyArray<unknown> }) =>
                    Effect.sync(() => {
                      prepared.push(request.checkouts);
                      return {
                        idle: true,
                        busy: { turns: 0, terminals: 0, clones: 0, checks: 0 },
                        kept: [],
                      };
                    }),
                },
              }),
            stops,
          },
          store: { listThreads: Effect.succeed([own]) },
          runtimes: { startSession: () => Effect.void, restSession: () => Effect.succeed("cold") },
        } as unknown as StopResumeDeps;
        const first = yield* resumeHost(deps, MACHINE);
        expect(first.refused).toEqual([
          { threadId: "t-orch", cwd, note: "main is here already with commits" },
        ]);
        expect(stops.blocked(MACHINE, "t-orch" as ThreadId)).toBeDefined();
        // The plain clone is there now; it is no stand-in for the kept work, at a stop or a keep.
        const stopped = yield* prepareStop(deps, MACHINE);
        expect(prepared).toEqual([[]]);
        expect(stopped.kept).toEqual([
          {
            threadId: "t-orch",
            cwd,
            pushed: false,
            note: expect.stringMatching(/wasn't put back/),
          },
        ]);
        expect(yield* keepThreadWork(deps, MACHINE, own)).toEqual([]);
        expect(keeps).toEqual([]);
        // The next resume asks the host again, though the path is there, and lifts the block.
        refuse = false;
        const second = yield* resumeHost(deps, MACHINE);
        expect(asked).toHaveLength(2);
        expect(second.restored.map((entry) => entry.threadId)).toEqual(["t-orch"]);
        expect(stops.blocked(MACHINE, "t-orch" as ThreadId)).toBeUndefined();
      }),
  );

  it("rebuilds a repository's URL from the identity recorded when it was cloned", () => {
    for (const url of [
      URL,
      "https://git.example.test:8443/group/sub/widgets",
      "ssh://git@git.example.test/acme/widgets.git",
      "ssh://git@git.example.test:2222/acme/widgets.git",
      "git@git.example.test:acme/widgets.git",
    ]) {
      const identity = cloneIdentityOf(url)!;
      expect(cloneIdentityOf(cloneUrlOf(identity)!)).toBe(identity);
    }
    expect(cloneUrlOf(cloneIdentityOf(URL)!)).toBe(URL);
    expect(cloneUrlOf("not json")).toBeUndefined();
    expect(cloneUrlOf(JSON.stringify(["file:", "h", "1", "", "/x/y"]))).toBeUndefined();
    expect(cloneUrlOf(JSON.stringify(["https:", "h", "443", "", "/../x/y"]))).toBeUndefined();
  });
});
