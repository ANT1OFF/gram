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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { type MachineMarksByHost, makeStopMarks, type StopMarks } from "./stop-marks.ts";
import { awaitedMachines, RESUME_STALLED, restoreGateOf, type WorkerHost } from "./worker-host.ts";
import { FOLDER_THERE, type KeepRequest, type RestoreRequest } from "./stop.ts";
import { cloneIdentityOf, cloneUrlOf } from "./repos.ts";
import {
  keepThreadWork,
  prepareStop,
  resumeHost,
  BLOCKED_RETRY_MS,
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

/** Marks whose writes fail while `failing` says so, of records holding what it names. */
const flaky = (failing: (all: MachineMarksByHost) => boolean) =>
  makeStopMarks(undefined, undefined, undefined, undefined, {
    initial: {},
    save: (all) => {
      if (failing(all)) throw new Error("disk full");
    },
  });

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
        // A session asked for after that is told at once, never opened over the folders as they
        // are; once a resume completes, it opens.
        const after = yield* Effect.exit(gated(stops)(MACHINE, "t-one" as ThreadId));
        expect(JSON.stringify(after)).toContain(RESUME_STALLED.slice(0, 40));
        stops.resumed(MACHINE, stops.resumeStarted(MACHINE), true);
        expect((yield* gated(stops)(MACHINE, "t-one" as ThreadId)).id).toBe(MACHINE);
      }),
    ),
  );

  it.effect("leaves the resume owed, and blocks nothing, when the connection goes under it", () =>
    Effect.gen(function* () {
      const { deps, started } = machine([], true);
      const stops = deps.hosts.stops;
      stops.expect(MACHINE);
      stops.back(MACHINE);
      let gone = false;
      const connection = {
        gone: () => gone,
        // The link drops as the machine is asked: what it says of the folders isn't known.
        git: {
          present: () =>
            Effect.sync(() => {
              gone = true;
              return false;
            }),
        },
        stop: {
          restore: () =>
            Effect.fail(new HostFailed({ message: "The machine's connection closed." })),
        },
      };
      const onLostLink = {
        ...deps,
        hosts: { ...deps.hosts, connection: () => Effect.succeed(connection) },
      } as unknown as StopResumeDeps;
      expect((yield* Effect.flip(resumeHost(onLostLink, MACHINE)))._tag).toBe("HostUnavailable");
      expect(stops.resuming(MACHINE)).toBe(true);
      for (const { id } of THREADS) expect(stops.blocked(MACHINE, id)).toBeUndefined();
      expect(started).toEqual([]);
    }),
  );

  it.effect("leaves the threads at rest to the resume of the disk the machine is on now", () =>
    Effect.gen(function* () {
      const { deps, started } = machine(["/home/dev/widgets"], true);
      const stops = deps.hosts.stops;
      stops.arrive(MACHINE, { diskId: "disk-aaaaaaaa" });
      stops.away(MACHINE);
      stops.back(MACHINE);
      // Replaced while the resume of the old disk runs.
      const onOldDisk = {
        ...deps,
        hosts: {
          ...deps.hosts,
          connection: () =>
            Effect.succeed({
              git: {
                present: () =>
                  Effect.sync(() => {
                    stops.arrive(MACHINE, { diskId: "disk-bbbbbbbb" });
                    return true;
                  }),
              },
              stop: {},
            }),
        },
      } as unknown as StopResumeDeps;
      expect((yield* Effect.flip(resumeHost(onOldDisk, MACHINE)))._tag).toBe("HostUnavailable");
      expect(started).toEqual([]);
      expect(stops.resuming(MACHINE)).toBe(true);
      // The new disk's own resume reopens them.
      yield* resumeHost(deps, MACHINE);
      expect(started).toContain("t-worker");
      expect(stops.resuming(MACHINE)).toBe(false);
    }),
  );

  it.effect("leaves the resume owed when the connection goes as a thread's session reopens", () =>
    Effect.gen(function* () {
      const { deps } = machine(["/home/dev/widgets", "/home/dev/project"], true);
      const stops = deps.hosts.stops;
      stops.stopped(MACHINE, ["t-worker" as ThreadId, "t-folder" as ThreadId]);
      stops.away(MACHINE);
      stops.back(MACHINE);
      let gone = false;
      const started: Array<ThreadId> = [];
      const dropping = {
        ...deps,
        hosts: {
          ...deps.hosts,
          connection: () =>
            Effect.map(deps.hosts.connection(MACHINE), (connection) => ({
              ...connection,
              gone: () => gone,
            })),
        },
        runtimes: {
          // The link drops while the first session opens; the open still answers.
          startSession: (threadId: ThreadId) =>
            Effect.sync(() => {
              started.push(threadId);
              gone = true;
            }),
        },
      } as unknown as StopResumeDeps;
      // Before, it went on and completed, and the debt was cleared over a machine that went.
      expect((yield* Effect.flip(resumeHost(dropping, MACHINE)))._tag).toBe("HostUnavailable");
      expect(stops.resuming(MACHINE)).toBe(true);
      // It stopped there, and nothing on the list was taken as reopened over the link that went:
      // the next resume reopens what is still at rest, or finds it open already.
      expect(started).toHaveLength(1);
      expect(stops.restedOf(MACHINE)).toEqual(["t-worker", "t-folder"]);
    }),
  );

  it.effect("keeps the threads at rest that a replacement interrupted, for the new disk", () =>
    Effect.gen(function* () {
      const { deps } = machine(["/home/dev/widgets", "/home/dev/project"], true);
      const stops = deps.hosts.stops;
      stops.arrive(MACHINE, { diskId: "disk-aaaaaaaa" });
      stops.away(MACHINE);
      stops.back(MACHINE);
      const started: Array<ThreadId> = [];
      const replacing = {
        ...deps,
        runtimes: {
          // Replaced while the first session opens.
          startSession: (threadId: ThreadId) =>
            Effect.sync(() => {
              started.push(threadId);
              stops.arrive(MACHINE, { diskId: "disk-bbbbbbbb" });
            }),
        },
      } as unknown as StopResumeDeps;
      expect((yield* Effect.flip(resumeHost(replacing, MACHINE)))._tag).toBe("HostUnavailable");
      // Before, the whole list was taken at once and lost with the old disk's resume.
      expect(stops.restedOf(MACHINE).length).toBeGreaterThan(0);
      expect(stops.resuming(MACHINE)).toBe(true);
    }),
  );

  it.effect("keeps a thread whose other folder is still coming back from opening", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = "/clones/widgets-trees/first";
        const second = "/clones/widgets-trees/second";
        const two = {
          ...thread("t-two", { path: first, cloneIdentity: cloneIdentityOf(URL)! }),
          extraCheckouts: [
            {
              kind: "worktree",
              hostId: MACHINE,
              path: second,
              cloneIdentity: cloneIdentityOf(URL)!,
            },
          ],
        } as unknown as Thread;
        const hang = yield* Deferred.make<void>();
        const asked: Array<string> = [];
        const restore = (request: RestoreRequest) =>
          Effect.gen(function* () {
            asked.push(request.cwd);
            if (request.cwd === second) yield* Deferred.await(hang);
            return { restored: true, commit: COMMIT } satisfies HostStopRestored;
          });
        const stops = makeStopMarks();
        stops.expect(MACHINE);
        stops.back(MACHINE);
        const deps = {
          hosts: {
            connection: () =>
              Effect.succeed({
                git: { present: () => Effect.succeed(false) },
                stop: { restore },
              }),
            stops,
          },
          store: { listThreads: Effect.succeed([two]) },
          runtimes: { startSession: () => Effect.void },
        } as unknown as StopResumeDeps;
        const resuming = yield* Effect.forkScoped(resumeHost(deps, MACHINE));
        yield* Effect.gen(function* () {
          while (asked.length < 2) yield* Effect.yieldNow;
        });
        // One of its folders back, the other not: it isn't back, and its session doesn't open.
        expect(stops.isThreadBack(MACHINE, "t-two" as ThreadId)).toBe(false);
        expect(restoreGateOf(stops, MACHINE, "t-two" as ThreadId)).toBe("wait");
        yield* Deferred.succeed(hang, undefined);
        yield* Fiber.join(resuming);
        expect(restoreGateOf(stops, MACHINE, "t-two" as ThreadId)).toBeUndefined();
      }),
    ),
  );

  it.effect("puts nothing back when the folders it sets out to put back can't be written", () =>
    Effect.gen(function* () {
      const { deps, asked } = machine([], true);
      const stops = flaky((all) => Object.values(all).some((each) => each.owedFolders));
      stops.expect(MACHINE);
      stops.back(MACHINE);
      const unwritable = { ...deps, hosts: { ...deps.hosts, stops } } as unknown as StopResumeDeps;
      // Before, the folders were put back with nothing written of it, and a crash then lost it.
      expect((yield* Effect.flip(resumeHost(unwritable, MACHINE)))._tag).toBe("HostUnavailable");
      expect(asked).toEqual([]);
      expect(stops.resuming(MACHINE)).toBe(true);
    }),
  );

  it.effect(
    "doesn't take a folder a resume set out to put back as there on a host's word alone",
    () =>
      Effect.gen(function* () {
        const cwd = "/clones/widgets-trees/worker";
        const worker = thread("t-worker", {
          path: cwd,
          branch: "gram/worker",
          repoRoot: "/clones/widgets",
          cloneIdentity: cloneIdentityOf(URL)!,
        });
        const pending: Array<boolean | undefined> = [];
        const answering = (checks: boolean) => {
          const stops = makeStopMarks();
          stops.expect(MACHINE);
          stops.back(MACHINE);
          stops.folderOwed(MACHINE, cwd);
          return {
            stops,
            deps: {
              hosts: {
                connection: () =>
                  Effect.succeed({
                    ...(checks
                      ? { hello: { capabilities: [], features: ["wip-restore-pending"] } }
                      : {}),
                    git: { present: () => Effect.succeed(true) },
                    stop: {
                      restore: (request: RestoreRequest) =>
                        Effect.sync(() => {
                          pending.push(request.pending);
                          return { restored: false, there: true, note: FOLDER_THERE };
                        }),
                    },
                  }),
                stops,
              },
              store: { listThreads: Effect.succeed([worker]) },
              runtimes: { startSession: () => Effect.void },
            } as unknown as StopResumeDeps,
          };
        };
        // A host that can't check it: its "there" is no confirmation, and the thread stays out.
        const old = answering(false);
        yield* resumeHost(old.deps, MACHINE);
        expect(old.stops.blocked(MACHINE, "t-worker" as ThreadId)).toContain("can't check it");
        // One that checks it was asked to, and its answer stands.
        const current = answering(true);
        yield* resumeHost(current.deps, MACHINE);
        expect(pending).toEqual([true, true]);
        expect(current.stops.blocked(MACHINE, "t-worker" as ThreadId)).toBeUndefined();
        expect(current.stops.isFolderOwed(MACHINE, cwd)).toBe(false);
      }),
  );

  it.effect("lifts the block of a folder the user put back by hand, once it is there", () =>
    Effect.gen(function* () {
      const only = thread("t-lost", { kind: "main", path: "/home/dev/lost" });
      const stops = makeStopMarks();
      stops.expect(MACHINE);
      stops.back(MACHINE);
      let there = false;
      const deps = {
        hosts: {
          connection: () =>
            Effect.succeed({
              git: { present: () => Effect.sync(() => there) },
              stop: { restore: () => Effect.die("never asked: Gram didn't make this folder") },
            }),
          stops,
        },
        store: { listThreads: Effect.succeed([only]) },
        runtimes: { startSession: () => Effect.void },
      } as unknown as StopResumeDeps;
      yield* resumeHost(deps, MACHINE);
      expect(stops.blocked(MACHINE, "t-lost" as ThreadId)).toBeDefined();
      // Put back where it was. Before, the block stood however often it was resumed.
      there = true;
      yield* resumeHost(deps, MACHINE);
      expect(stops.blocked(MACHINE, "t-lost" as ThreadId)).toBeUndefined();
    }),
  );

  it.effect("keeps a thread at rest on the list until its session is seen open", () =>
    Effect.gen(function* () {
      const { deps } = machine(["/home/dev/widgets", "/home/dev/project"], true);
      const stops = deps.hosts.stops;
      stops.stopped(MACHINE, ["t-worker" as ThreadId, "t-folder" as ThreadId]);
      stops.away(MACHINE);
      stops.back(MACHINE);
      // Its start was asked and answered, but the session failed as it opened.
      const failing = {
        ...deps,
        runtimes: {
          startSession: () => Effect.succeed("starting"),
          snapshot: Effect.succeed([
            { thread: { id: "t-worker" }, status: "error" },
            { thread: { id: "t-folder" }, status: "idle" },
          ]),
        },
      } as unknown as StopResumeDeps;
      const resumed = yield* resumeHost(failing, MACHINE);
      expect(resumed.reopened).toEqual(["t-folder"]);
      // Before, it left the list as soon as its start was asked.
      expect(stops.restedOf(MACHINE)).toEqual(["t-worker"]);
    }),
  );

  it.effect("says it failed when its end can't be written, and the machine stays owed", () =>
    Effect.gen(function* () {
      const { deps } = machine([], true);
      let failing = false;
      const stops = flaky(() => failing);
      stops.expect(MACHINE);
      stops.back(MACHINE);
      const onFlaky = {
        ...deps,
        hosts: { ...deps.hosts, stops },
        runtimes: {
          startSession: () =>
            Effect.sync(() => {
              failing = true;
            }),
        },
      } as unknown as StopResumeDeps;
      stops.stopped(MACHINE, ["t-worker" as ThreadId]);
      stops.away(MACHINE);
      stops.back(MACHINE);
      // Before, the caller was told it was resumed while the machine still owed it.
      expect((yield* Effect.flip(resumeHost(onFlaky, MACHINE)))._tag).toBe("HostUnavailable");
      expect(stops.resuming(MACHINE)).toBe(true);
    }),
  );

  it.effect("resumes a machine with blocked folders again now and then, hosted features off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const only = thread("t-lost", { kind: "main", path: "/home/dev/lost" });
        const stops = makeStopMarks();
        stops.expect(MACHINE);
        stops.back(MACHINE);
        let there = false;
        const deps = {
          hosts: {
            connection: () =>
              Effect.succeed({ git: { present: () => Effect.sync(() => there) }, stop: {} }),
            stops,
            machines: { list: () => [{ id: MACHINE, name: "box", confirmedAt: 1 }] } as never,
            watch: () => () => {},
          },
          store: { listThreads: Effect.succeed([only]) },
          runtimes: { startSession: () => Effect.void },
          settings: {
            getSettings: Effect.succeed({ experimental: { embedding: false } } as never),
          },
        };
        yield* resumeOwedMachines(deps as never);
        yield* TestClock.adjust("1 second");
        expect(stops.owes(MACHINE)).toBe(false);
        expect(stops.blocked(MACHINE, "t-lost" as ThreadId)).toBeDefined();
        there = true;
        yield* TestClock.adjust(`${BLOCKED_RETRY_MS + 60_000} millis`);
        expect(stops.blocked(MACHINE, "t-lost" as ThreadId)).toBeUndefined();
      }),
    ),
  );

  it.effect("doesn't take a user's own folder as back for being there, unreadable", () =>
    Effect.gen(function* () {
      const only = thread("t-lost", { kind: "main", path: "/home/dev/lost" });
      const stops = makeStopMarks();
      stops.expect(MACHINE);
      stops.back(MACHINE);
      let readable = false;
      const deps = {
        hosts: {
          connection: () =>
            Effect.succeed({
              git: {
                present: () => Effect.succeed(true),
                local: () =>
                  readable ? Effect.succeed({}) : Effect.fail(new Error("not a git repository")),
              },
              stop: {},
            }),
          stops,
        },
        store: { listThreads: Effect.succeed([only]) },
        runtimes: { startSession: () => Effect.void },
      } as unknown as StopResumeDeps;
      // An empty or unreadable folder at the path. Before, being there was enough.
      const first = yield* resumeHost(deps, MACHINE);
      expect(first.refused).toHaveLength(1);
      expect(stops.blocked(MACHINE, "t-lost" as ThreadId)).toBeDefined();
      // A repository again: back, and said to be unchecked.
      readable = true;
      const second = yield* resumeHost(deps, MACHINE);
      expect(second.unverified).toEqual([{ threadId: "t-lost", cwd: "/home/dev/lost" }]);
      expect(stops.blocked(MACHINE, "t-lost" as ThreadId)).toBeUndefined();
    }),
  );

  it.effect("checks a folder that is there on a new disk, and one a user's thread shares", () =>
    Effect.gen(function* () {
      const cwd = "/clones/widgets";
      const managed = thread("t-orch", {
        kind: "current",
        path: cwd,
        branch: "main",
        cloneIdentity: cloneIdentityOf(URL)!,
      } as never);
      // Another thread with the same path as a folder of its own, no clone behind it.
      const picked = thread("t-mine", { kind: "main", path: cwd });
      const stops = makeStopMarks();
      stops.arrive(MACHINE, { diskId: "disk-aaaaaaaa" });
      stops.arrive(MACHINE, { diskId: "disk-bbbbbbbb" });
      const asked: Array<RestoreRequest> = [];
      const deps = {
        hosts: {
          connection: () =>
            Effect.succeed({
              hello: { capabilities: [], features: ["wip-restore-pending"] },
              // There already on the new disk: a plain clone, say, without the thread's work.
              git: { present: () => Effect.succeed(true) },
              stop: {
                restore: (request: RestoreRequest) =>
                  Effect.sync(() => {
                    asked.push(request);
                    return { restored: true, commit: COMMIT } satisfies HostStopRestored;
                  }),
              },
            }),
          stops,
        },
        store: { listThreads: Effect.succeed([picked, managed]) },
        runtimes: { startSession: () => Effect.void },
      } as unknown as StopResumeDeps;
      yield* resumeHost(deps, MACHINE);
      // Before, it was taken as back for being there, for both.
      expect(asked.map((request) => [request.cwd, request.pending])).toEqual([[cwd, true]]);
    }),
  );

  it.effect(
    "puts a thread's intact folder through nothing for a sibling that couldn't come back",
    () =>
      Effect.gen(function* () {
        const primary = "/clones/widgets-trees/primary";
        const secondary = "/clones/widgets-trees/secondary";
        const two = {
          ...thread("t-two", { path: primary, cloneIdentity: cloneIdentityOf(URL)! }),
          extraCheckouts: [
            {
              kind: "worktree",
              hostId: MACHINE,
              path: secondary,
              cloneIdentity: cloneIdentityOf(URL)!,
            },
          ],
        } as unknown as Thread;
        const asked: Array<string> = [];
        let fails = true;
        const stops = makeStopMarks();
        stops.expect(MACHINE);
        stops.back(MACHINE);
        const deps = {
          hosts: {
            connection: () =>
              Effect.succeed({
                hello: { capabilities: [], features: ["wip-restore-pending"] },
                git: { present: (cwd: string) => Effect.succeed(cwd === primary) },
                stop: {
                  restore: (request: RestoreRequest) =>
                    Effect.suspend(() => {
                      asked.push(request.cwd);
                      // The primary holds work of its own: asked to put anything back, refused.
                      if (request.cwd === primary)
                        return Effect.fail(new HostFailed({ message: "has changes of its own" }));
                      return fails
                        ? Effect.fail(new HostFailed({ message: "git fetch failed" }))
                        : Effect.succeed({
                            restored: true,
                            commit: COMMIT,
                          } satisfies HostStopRestored);
                    }),
                },
              }),
            stops,
          },
          store: { listThreads: Effect.succeed([two]) },
          runtimes: { startSession: () => Effect.void },
        } as unknown as StopResumeDeps;
        yield* resumeHost(deps, MACHINE);
        expect(stops.blocked(MACHINE, "t-two" as ThreadId)).toBeDefined();
        fails = false;
        asked.length = 0;
        stops.expect(MACHINE);
        stops.back(MACHINE);
        yield* resumeHost(deps, MACHINE);
        // Before, the whole thread's block put the primary through again, refused, for good.
        expect(asked).toEqual([secondary]);
        expect(stops.blocked(MACHINE, "t-two" as ThreadId)).toBeUndefined();
      }),
  );

  it.effect("tries a thread at rest whose session didn't open again, less often each time", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { deps } = machine(["/home/dev/widgets", "/home/dev/project"], true);
        const stops = deps.hosts.stops;
        stops.stopped(MACHINE, ["t-worker" as ThreadId]);
        stops.away(MACHINE);
        stops.back(MACHINE);
        let status = "error";
        let starts = 0;
        const retrying = {
          ...deps,
          hosts: {
            ...deps.hosts,
            machines: { list: () => [{ id: MACHINE, name: "box", confirmedAt: 1 }] } as never,
            watch: () => () => {},
          },
          runtimes: {
            startSession: () => Effect.sync(() => void (starts += 1)),
            snapshot: Effect.sync(() => [
              { thread: { id: "t-worker" }, status },
              { thread: { id: "t-folder" }, status: "idle" },
            ]),
          },
          settings: { getSettings: Effect.succeed({ experimental: { embedding: true } } as never) },
        };
        // The resume ran, the machine owes nothing, but its session failed as it opened.
        yield* resumeHost(retrying as unknown as StopResumeDeps, MACHINE);
        expect(stops.owes(MACHINE)).toBe(false);
        expect(stops.restedOf(MACHINE)).toEqual(["t-worker"]);
        status = "idle";
        yield* resumeOwedMachines(retrying as never);
        yield* TestClock.adjust("1 second");
        // Before, nothing tried it again once the machine owed nothing.
        expect(starts).toBe(3);
        expect(stops.restedOf(MACHINE)).toEqual([]);
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
          stops.arrive(MACHINE, { diskId: "disk-aaaaaaaa" });
          stops.arrive(MACHINE, { diskId: "disk-bbbbbbbb" });
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
          stops.arrive(MACHINE, { diskId: "disk-cccccccc" });
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
    "asks again of a clone an interrupted resume made but didn't put its thread's work in",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // A worker's worktree of the clone, and the orchestrator's own folder, the clone itself.
          const clone = "/clones/widgets";
          const worktree = thread("t-worker", {
            path: "/clones/widgets-trees/worker",
            branch: "gram/worker",
            repoRoot: clone,
            cloneIdentity: cloneIdentityOf(URL)!,
          });
          const own = thread("t-orch", {
            kind: "current",
            path: clone,
            branch: "main",
            cloneIdentity: cloneIdentityOf(URL)!,
          } as never);
          const disk = new Set<string>();
          const asked: Array<string> = [];
          const hang = yield* Deferred.make<void>();
          let first = true;
          const restore = (request: RestoreRequest) =>
            Effect.gen(function* () {
              asked.push(request.cwd);
              // Putting the worktree back makes the plain clone behind it first.
              disk.add(clone);
              if (request.cwd === clone && first) yield* Deferred.await(hang);
              disk.add(request.cwd);
              return { restored: true, commit: COMMIT } satisfies HostStopRestored;
            });
          const stops = makeStopMarks();
          stops.expect(MACHINE);
          stops.back(MACHINE);
          const deps = {
            hosts: {
              connection: () =>
                Effect.succeed({
                  git: { present: (at: string) => Effect.sync(() => disk.has(at)) },
                  stop: { restore },
                }),
              stops,
            },
            store: { listThreads: Effect.succeed([worktree, own]) },
            runtimes: { startSession: () => Effect.void },
          } as unknown as StopResumeDeps;
          // The first resume is cut off with the worktree back and the clone's own work not.
          const cut = yield* Effect.forkScoped(resumeHost(deps, MACHINE));
          yield* Effect.gen(function* () {
            while (!asked.includes(clone) || !disk.has("/clones/widgets-trees/worker"))
              yield* Effect.yieldNow;
          });
          yield* Fiber.interrupt(cut);
          first = false;
          asked.length = 0;
          // The clone is on the disk now, but only as the worktree's restore left it: the next
          // resume asks for the thread's work in it rather than take it for put back.
          stops.expect(MACHINE);
          stops.back(MACHINE);
          yield* resumeHost(deps, MACHINE);
          expect(asked).toContain(clone);
        }),
      ),
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
