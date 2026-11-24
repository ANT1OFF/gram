// Moving a worker between two joined machines, between its turns, and who may ask for it. Fake
// hosts answer the keep and the restore: no machine, no git, no network.

import { describe, expect, it } from "@effect/vitest";
import {
  type AppToolError,
  type Checkout,
  type HostId,
  InvalidState,
  type Thread,
  type ThreadId,
  type ThreadStatus,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { cloneIdentityOf } from "../host/repos.ts";
import { makeWorkerMachineTools } from "./worker-machines-tool.ts";
import { moveWorkerTo, WorkerNotMoved, type WorkerMoveDeps } from "./worker-moves.ts";

const FROM = "m-from" as HostId;
const TO = "m-to" as HostId;
const COMMIT = "a".repeat(40);
const URL = "https://github.com/acme/shop.git";
const IDENTITY = cloneIdentityOf(URL)!;
const ORCHESTRATOR = "t-orchestrator" as ThreadId;

const checkout = (path: string, hostId: HostId = FROM): Checkout => ({
  kind: "worktree",
  path,
  hostId,
  branch: "feat/x",
  cloneIdentity: IDENTITY,
  repoRoot: "/old/repos/shop",
});

const worker = (more: Partial<Thread> = {}): Thread =>
  ({
    id: "t-worker" as ThreadId,
    title: "Fix the cart",
    projectId: "p-shop",
    checkout: checkout("/old/repos/shop/.worktrees/feat-x"),
    spawnedBy: {
      threadId: ORCHESTRATOR,
      feature: "cart",
      placement: { machine: "worker-00000000aa", packing: "shared", seat: "seat-old" },
    },
    ...more,
  }) as unknown as Thread;

/** Two machines and the runtime, as a move reads them. */
const world = (
  options: {
    readonly keeps?: (cwd: string) => object;
    readonly restores?: (cwd: string) => object;
    readonly targetFeatures?: ReadonlyArray<string>;
    readonly atWork?: boolean;
  } = {},
) => {
  const calls: string[] = [];
  let stored: Thread | undefined;
  const connection = (id: HostId) => ({
    hello: {
      capabilities: [],
      features: id === TO ? (options.targetFeatures ?? ["wip-restore-ref"]) : [],
    },
    stop: {
      keep: (request: { checkouts: ReadonlyArray<{ threadId: ThreadId; cwd: string }> }) =>
        Effect.sync(() => {
          calls.push(`keep@${id}`);
          return request.checkouts.map((each) => ({
            ...each,
            ref: `refs/gram/wip/${each.threadId}`,
            commit: COMMIT,
            branch: "feat/x",
            pushed: true,
            ...options.keeps?.(each.cwd),
          }));
        }),
      restore: (request: { cwd: string; commit?: string; ref?: string }) =>
        Effect.sync(() => {
          calls.push(`restore@${id}:${request.cwd}:${request.ref ?? "branch"}`);
          return { restored: true, commit: request.commit, ...options.restores?.(request.cwd) };
        }),
    },
    repos: { ensure: () => Effect.succeed({ path: "/new/repos/shop" }) },
    worktrees: {
      remove: (request: { worktreeDir: string; force: boolean }) =>
        Effect.sync(() => {
          calls.push(`remove@${id}:${request.worktreeDir}:${request.force ? "force" : "clean"}`);
        }),
    },
  });
  const deps = {
    hosts: {
      connection: (id: HostId) => Effect.succeed(connection(id)),
      machines: {},
      stops: { blocked: () => undefined, keep: () => undefined },
    },
    runtimes: {
      relocate: (
        threadId: ThreadId,
        plan: { from: Checkout; prepare: Effect.Effect<Checkout, WorkerNotMoved> },
      ) =>
        options.atWork === true
          ? Effect.fail(
              new InvalidState({ message: "the thread is at work", threadId, status: "running" }),
            )
          : Effect.map(plan.prepare, (placed) => {
              stored = { ...(stored ?? worker()), checkout: placed };
              return stored;
            }),
      updateThread: (_id: ThreadId, f: (thread: Thread) => Thread) =>
        Effect.sync(() => {
          stored = f(stored ?? worker());
          return stored;
        }),
    },
  } as unknown as WorkerMoveDeps;
  return { deps, calls, stored: () => stored };
};

const target = { id: TO, name: "worker-00000000bb" };

const refused = (thread: Thread, options: Parameters<typeof world>[0] = {}) =>
  Effect.gen(function* () {
    const { deps, calls } = world(options);
    const exit = yield* Effect.exit(moveWorkerTo(deps, thread, target));
    expect(calls).toEqual([]);
    return Exit.isFailure(exit) ? String(exit.cause) : "moved";
  });

describe("a worker moved to another machine", () => {
  it.effect(
    "keeps its work at the remote, puts it back there, and only then points the thread",
    () =>
      Effect.gen(function* () {
        const { deps, calls, stored } = world();
        const done = yield* moveWorkerTo(deps, worker(), target);
        expect(done.moved).toBe(true);
        expect(calls).toEqual([
          `keep@${FROM}`,
          `restore@${TO}:/new/repos/shop/.worktrees/feat-x:refs/gram/wip/t-worker`,
          // The folder it left goes only if nothing in it is uncommitted: never by force.
          `remove@${FROM}:/old/repos/shop/.worktrees/feat-x:clean`,
        ]);
        expect(stored()?.checkout).toMatchObject({
          path: "/new/repos/shop/.worktrees/feat-x",
          hostId: TO,
          branch: "feat/x",
          repoRoot: "/new/repos/shop",
        });
      }),
  );

  it.effect("carries each repo it works in, and lets go of folders it could only read there", () =>
    Effect.gen(function* () {
      const { deps, stored } = world();
      const spanning = worker({
        extraCheckouts: [checkout("/old/repos/shop/.worktrees/feat-x-warehouse")],
        additionalDirectories: [
          "/old/repos/shop/.worktrees/feat-x-warehouse",
          "/old/repos/shop/.worktrees/a-sibling",
        ],
      });
      yield* moveWorkerTo(deps, spanning, target);
      expect(stored()?.extraCheckouts?.map((each) => each.hostId)).toEqual([TO]);
      expect(stored()?.additionalDirectories).toEqual(
        stored()?.extraCheckouts?.map((each) => each.path),
      );
    }),
  );

  it.effect("leaves the worker where it was when its work can't be kept or put back", () =>
    Effect.gen(function* () {
      const unkept = world({ keeps: () => ({ pushed: false, note: "No remote to push to." }) });
      const first = yield* Effect.exit(moveWorkerTo(unkept.deps, worker(), target));
      expect(Exit.isFailure(first) && String(first.cause)).toMatch(
        /couldn't be kept at the remote/,
      );
      expect(unkept.calls.some((call) => call.startsWith("restore"))).toBe(false);
      expect(unkept.stored()).toBeUndefined();

      // Put back, but not at the commit that was kept: the folder made there is taken away.
      const wrong = world({ restores: () => ({ commit: "b".repeat(40) }) });
      const second = yield* Effect.exit(moveWorkerTo(wrong.deps, worker(), target));
      expect(Exit.isFailure(second) && String(second.cause)).toMatch(
        /couldn't put its folder back/,
      );
      expect(wrong.calls.at(-1)).toBe(`remove@${TO}:/new/repos/shop/.worktrees/feat-x:force`);
      expect(wrong.stored()).toBeUndefined();
    }),
  );

  it.effect("refuses what it can't carry, before anything is kept", () =>
    Effect.gen(function* () {
      // On this machine, in a folder no joined machine keeps.
      expect(
        yield* refused(worker({ checkout: { kind: "worktree", path: "/home/me/shop" } })),
      ).toMatch(/runs on this machine/);
      // A folder not made from a clone its machine keeps.
      const { cloneIdentity: _none, ...plain } = checkout("/old/somewhere");
      expect(yield* refused(worker({ checkout: plain }))).toMatch(/wasn't made from a clone/);
      // A machine whose host can't take another machine's ref.
      expect(yield* refused(worker(), { targetFeatures: [] })).toMatch(/older Gram host/);
    }),
  );

  it.effect("says a worker in a turn is busy, so it can be moved once it rests", () =>
    Effect.gen(function* () {
      const { deps } = world({ atWork: true });
      const exit = yield* Effect.exit(moveWorkerTo(deps, worker(), target));
      const failure = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
      const error = failure !== undefined && "error" in failure ? failure.error : undefined;
      expect(error).toBeInstanceOf(WorkerNotMoved);
      expect((error as WorkerNotMoved).busy).toBe(true);
    }),
  );

  it.effect("does nothing for a worker already there", () =>
    Effect.gen(function* () {
      const { deps, calls } = world();
      const there = worker({ checkout: checkout("/new/repos/shop/.worktrees/feat-x", TO) });
      expect((yield* moveWorkerTo(deps, there, target)).moved).toBe(false);
      expect(calls).toEqual([]);
    }),
  );
});

const tools = (statuses: Record<string, ThreadStatus>, threads: ReadonlyArray<Thread>) =>
  Effect.gen(function* () {
    const planned: unknown[] = [];
    const made = yield* makeWorkerMachineTools({
      sandbox: {
        store: {
          getThread: (id: ThreadId) => {
            const found = threads.find((each) => each.id === id);
            return found === undefined ? Effect.fail(new Error("none")) : Effect.succeed(found);
          },
          listThreads: Effect.succeed(threads),
        },
        joined: () => [],
        orchestration: {},
        onDemand: undefined,
        signedIn: undefined,
        workerHosts: undefined,
      } as never,
      planner: ((_caller: ThreadId, _input: unknown, to: unknown) => {
        planned.push(to);
        return Effect.succeed(undefined);
      }) as never,
      runtimes: {
        status: (id: ThreadId) => Effect.succeed(statuses[id] ?? "idle"),
      } as never,
      remoteHosts: { connection: () => Effect.fail(new Error("unused")) } as never,
    });
    const place = made.find((each) => each.descriptor.name === "place_worker")!;
    const call = (caller: string, input: object) =>
      (
        place.handle(caller as ThreadId, input as never, {} as never) as Effect.Effect<
          Record<string, unknown>,
          AppToolError
        >
      ).pipe(Effect.exit);
    return { call, planned };
  });

const why = (exit: Exit.Exit<unknown, AppToolError>) =>
  Exit.isFailure(exit) ? String(exit.cause) : "allowed";

describe("who may move a worker, and where", () => {
  const mine = worker();
  const others = worker({
    id: "t-other" as ThreadId,
    title: "Another's",
    spawnedBy: { threadId: "t-elsewhere" as ThreadId, feature: "f" },
  });
  const exclusive = worker({
    id: "t-exclusive" as ThreadId,
    title: "Reads the web",
    spawnedBy: {
      threadId: ORCHESTRATOR,
      feature: "f",
      placement: { machine: "worker-00000000cc", packing: "exclusive" },
    },
  });
  const orchestrator = { id: ORCHESTRATOR, title: "Orchestrator" } as unknown as Thread;
  const all = [orchestrator, mine, others, exclusive];
  it.effect("lets an orchestrator move only its own workers", () =>
    Effect.gen(function* () {
      const { call, planned } = yield* tools({}, all);
      expect(why(yield* call(ORCHESTRATOR, { threadId: "t-other", to: { own: true } }))).toMatch(
        /not one of your workers/,
      );
      expect(why(yield* call(ORCHESTRATOR, { threadId: "t-worker" }))).toMatch(/Say where/);
      expect(why(yield* call(ORCHESTRATOR, { threadId: "t-worker", to: { own: false } }))).toMatch(
        /isn't moved onto its orchestrator's own machine/,
      );
      expect(planned).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("lets a worker ask only for a machine of its own, and only for itself", () =>
    Effect.gen(function* () {
      const { call, planned } = yield* tools({ "t-worker": "running" }, all);
      // Packing itself beside a sibling would let it reach that sibling's files.
      for (const to of [{ shared: true }, { shareWith: "t-exclusive" }, { own: false }])
        expect(why(yield* call("t-worker", { to }))).toMatch(/only ask for a machine of its own/);
      expect(why(yield* call("t-worker", { threadId: "t-exclusive", to: { own: true } }))).toMatch(
        /moves only itself/,
      );
      // It asks from inside its own turn, which can't be carried: its next start goes there.
      const asked = yield* call("t-worker", { to: { own: true } });
      expect(Exit.isSuccess(asked) && asked.value).toMatchObject({ queued: true });
      expect(planned).toEqual([]);
      const dropped = yield* call("t-worker", { cancel: true });
      expect(Exit.isSuccess(dropped) && dropped.value).toEqual({ cancelled: true });
    }).pipe(Effect.scoped),
  );

  it.effect("never moves a worker placed exclusive onto a machine it would share", () =>
    Effect.gen(function* () {
      const { call } = yield* tools({}, all);
      for (const to of [{ shared: true }, { shareWith: "t-worker" }])
        expect(why(yield* call(ORCHESTRATOR, { threadId: "t-exclusive", to }))).toMatch(
          /never shared/,
        );
    }).pipe(Effect.scoped),
  );

  it.effect("queues a move for a worker in a turn, and tries one at rest at once", () =>
    Effect.gen(function* () {
      const busy = yield* tools({ "t-worker": "running" }, all);
      const queued = yield* busy.call(ORCHESTRATOR, { threadId: "t-worker", to: { shared: true } });
      expect(Exit.isSuccess(queued) && queued.value).toMatchObject({ queued: true });
      expect(busy.planned).toEqual([]);
      const rested = yield* tools({ "t-worker": "idle" }, all);
      yield* rested.call(ORCHESTRATOR, { threadId: "t-worker", to: { shared: true } });
      expect(rested.planned).toEqual([{ shared: true }]);
    }).pipe(Effect.scoped),
  );
});
