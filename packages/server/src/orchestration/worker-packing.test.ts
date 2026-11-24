// How tightly an orchestrator's workers are packed onto its hosted machines: the cap, the pool a
// `shared` spawn joins, the seats a provider keeps, and the workspace's default. A fake app
// answers for a hosted server: no network, and no machine is ever started.

import { describe, expect, it } from "@effect/vitest";
import type { OrchestratorCharter, Thread, ThreadId, WorkspaceId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { signedInSource, type WorkerMachinePortShape } from "../embedding/signed-in-workers.ts";
import { memoryMachineClaims } from "../embedding/worker-machine-claims.ts";
import { makeWorkerSandbox } from "./worker-sandbox.ts";
import {
  machineCap,
  makeSeatHolds,
  packingOn,
  releaseFence,
  picksMismatch,
  picksOn,
  reservedSeats,
  workersOnMachine,
} from "./worker-packing.ts";
import { withReserved } from "../embedding/worker-seat-upkeep.ts";
import type { WorkerSandbox } from "./tool-inputs.ts";
import { machineNamedIn } from "./service/machine-named.ts";

const SERVER = { origin: "https://hosted.example.test", server: "Example hosted" };
const CALLER = "t-orchestrator" as ThreadId;
const WORKSPACE = "w-shop" as WorkspaceId;

const worker = (
  id: string,
  machineId: string,
  placement: NonNullable<Thread["spawnedBy"]>["placement"],
  more: Partial<Thread> = {},
) =>
  ({
    id: id as ThreadId,
    title: `Worker ${id}`,
    checkout: { kind: "worktree", path: `/repos/shop/.worktrees/${id}`, hostId: machineId },
    spawnedBy: { threadId: CALLER, feature: "f", ...(placement ? { placement } : {}) },
    ...more,
  }) as unknown as Thread;

describe("which workers count against a machine", () => {
  it("counts every open worker there, finished or at work, and never a parked one", () => {
    const threads = [
      worker("a", "m-1", { machine: "worker-1", packing: "shared" }),
      worker("done", "m-1", { machine: "worker-1", packing: "shared" }),
      worker("parked", "m-1", { machine: "worker-1" }, { parked: true }),
      worker("elsewhere", "m-2", { machine: "worker-2" }),
    ];
    // Whether the ledger reads `done` as finished is not asked: it is open, and can be messaged
    // back to work, so its place is its own until it is archived.
    expect(workersOnMachine(threads, "m-1").map((each) => each.id)).toEqual(["a", "done"]);
    // A worker detached from its workspace is no orchestrator's, and still runs there.
    const detached = { ...threads[0]!, id: "detached", spawnedBy: undefined } as never as Thread;
    expect(workersOnMachine([detached], "m-1")).toHaveLength(1);
  });

  it("caps a machine at what its provider says, lowered and never raised by the workspace", () => {
    const sharing = { workers: { large: 4, xlarge: 8 } };
    expect(machineCap(undefined, sharing, { size: "xlarge" })).toBe(8);
    expect(machineCap({ workersPerMachine: 2 }, sharing, { size: "xlarge" })).toBe(2);
    expect(machineCap({ workersPerMachine: 8 }, sharing, { size: "large" })).toBe(4);
    // The provider's own count for that machine wins over its table.
    expect(
      machineCap(undefined, sharing, {
        size: "xlarge",
        row: { name: "worker-1", running: true, workers: [], cap: 1, size: "xlarge" },
      }),
    ).toBe(1);
    // A provider that says nothing: four, and a size it has no word for likewise.
    expect(machineCap(undefined, undefined, { size: "xlarge" })).toBe(4);
    expect(machineCap(undefined, sharing, {})).toBe(4);
    expect(machineCap({ workersPerMachine: 1 }, undefined, {})).toBe(1);
  });

  it("reads how a machine is packed, and what it was started with, from the workers on it", () => {
    const threads = [
      worker("a", "m-1", {
        machine: "worker-1",
        packing: "shared",
        picks: { environment: "data", size: "large" },
      }),
      worker("b", "m-1", { machine: "worker-1", packing: "named", picks: { size: "small" } }),
      worker("c", "m-2", { machine: "worker-2", packing: "exclusive" }),
      worker("d", "m-3", { machine: "worker-3" }),
    ];
    expect(packingOn(threads, "m-1")).toBe("shared");
    expect(packingOn(threads, "m-2")).toBe("exclusive");
    expect(packingOn(threads, "m-3")).toBeUndefined();
    expect(picksOn(threads, "m-1")).toEqual({ environment: "data", size: "large" });
    expect(picksMismatch({ environment: "data" }, picksOn(threads, "m-1"))).toBeUndefined();
    expect(picksMismatch({ environment: "web" }, picksOn(threads, "m-1"))).toMatch(
      /environment web/,
    );
    expect(picksMismatch({ architecture: "amd64" }, picksOn(threads, "m-1"))).toMatch(
      /no architecture named/,
    );
    // Nothing says what the machine was started with: nothing is refused on its account.
    expect(picksMismatch({ environment: "web" }, picksOn(threads, "m-3"))).toBeUndefined();
  });

  it("holds a spawn's seat until it is let go or its time is up", () => {
    let now = 1_000;
    const holds = makeSeatHolds(() => now);
    holds.hold("worker-1", "s1");
    holds.hold("worker-1", "s2", 5_000);
    expect(holds.on("worker-1")).toEqual(["s1", "s2"]);
    holds.release("worker-1", "s1");
    expect(holds.on("worker-1")).toEqual(["s2"]);
    now += 5_000;
    expect(holds.on("worker-1")).toEqual([]);
    expect(holds.machines()).toEqual([]);
  });
});

interface Call {
  readonly call: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * A planner over a fake hosted server. A machine is online here as soon as it is started. The
 * server keeps seats, with `cap` a machine, unless `seats` is false, when it says nothing of
 * sharing and answers the seat calls 404.
 */
const setup = (
  options: {
    readonly charter?: Partial<OrchestratorCharter>;
    readonly threads?: () => ReadonlyArray<Thread>;
    readonly seats?: boolean;
    readonly cap?: number;
    readonly refuseSeat?: string;
    readonly offered?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const calls: Call[] = [];
    const online = new Map<string, { id: string; name: string }>();
    const seated = new Map<string, string[]>();
    const keeps = options.seats !== false;
    const cap = options.cap ?? 4;
    const port: WorkerMachinePortShape = {
      available: options.offered !== false,
      server: () => Effect.succeed({ ok: true as const, server: SERVER }),
      call: (_origin, call, body) =>
        Effect.sync(() => {
          calls.push({ call, body });
          const name = String(body["name"] ?? "");
          if (call === "choices")
            return {
              ok: true as const,
              status: 200,
              body: {
                choices: [
                  {
                    id: "size",
                    label: "Size",
                    default: "large",
                    options: [
                      { id: "large", label: "Large" },
                      { id: "xlarge", label: "Extra large" },
                    ],
                  },
                  {
                    id: "environment",
                    label: "Environment",
                    default: "workspace",
                    options: [
                      { id: "workspace", label: "Workspace" },
                      { id: "data", label: "Data" },
                    ],
                  },
                ],
                ...(keeps
                  ? { sharing: { workers: { large: cap, xlarge: cap * 2 }, size: "large" } }
                  : {}),
              },
            };
          if (call === "start") {
            online.set(name, { id: `m-${name}`, name });
            return { ok: true as const, status: 202, body: { name } };
          }
          if (call === "machines")
            return keeps
              ? { ok: true as const, status: 200, body: { machines: [] } }
              : { ok: true as const, status: 404, body: { code: "not_found" } };
          if (call === "workers") {
            if (!keeps) return { ok: true as const, status: 404, body: { code: "not_found" } };
            const here = seated.get(name) ?? [];
            const attach = body["attach"] as { worker: string } | undefined;
            const detach = (body["detach"] as string[] | undefined) ?? [];
            if (attach !== undefined && options.refuseSeat !== undefined)
              return {
                ok: true as const,
                status: 409,
                body: { code: options.refuseSeat, message: "Refused there.", cap, workers: here },
              };
            const after = [
              ...here.filter((seat) => !detach.includes(seat)),
              ...(attach === undefined ? [] : [attach.worker]),
            ];
            seated.set(name, after);
            return { ok: true as const, status: 200, body: { workers: after, cap, size: "large" } };
          }
          return { ok: true as const, status: 200, body: {} };
        }),
      relay: () => undefined,
      unrelay: () => undefined,
      relays: () => undefined,
      onDial: () => undefined,
      marks: () => Effect.succeed([]),
      onSignIns: () => undefined,
    };
    const hosts = {
      list: () =>
        [...online.values()].map((machine) => ({
          ...machine,
          onDemand: "worker",
          via: SERVER.origin,
          onlineSince: 1,
        })),
      remove: () => false,
      machines: {
        provision: () => {
          throw new Error("not registered here");
        },
      },
    };
    const source = signedInSource(SERVER, { port, hosts });
    const threads = options.threads ?? (() => []);
    const claims = memoryMachineClaims();
    const plan = yield* makeWorkerSandbox({
      claims,
      busy: (archived) =>
        Effect.succeed(
          new Set(
            archived.filter((each) => each.title.includes("mid-turn")).map((each) => each.id),
          ),
        ),
      orchestration: {
        ledger: () => Effect.succeed({ features: [] }),
      } as never,
      store: {
        getThread: () =>
          Effect.succeed({ checkout: { kind: "main", path: "/repo" }, workspaceId: WORKSPACE }),
        getWorkspace: () =>
          Effect.succeed({ charter: { maxConcurrentWorkers: 10, ...options.charter } }),
        listThreads: Effect.sync(threads),
      } as never,
      onDemand: undefined,
      signedIn:
        options.offered === false
          ? undefined
          : ({ port, source: Effect.succeed({ source, server: SERVER }) } as never),
      workerHosts: undefined,
      joined: () => hosts.list() as never,
    });
    let asked = 0;
    const spawn = (sandbox: WorkerSandbox | undefined, title = `Spawn ${++asked}`) =>
      plan(CALLER, { title, feature: "f", project: "shop" }, sandbox);
    const startsOf = () => calls.filter((each) => each.call === "start");
    const attachesOf = () =>
      calls.filter((each) => each.call === "workers" && each.body["attach"] !== undefined);
    return { spawn, plan, calls, startsOf, attachesOf, online, seated, claims };
  });

const prepare = (planned: { readonly prepare: Effect.Effect<unknown, unknown, Scope.Scope> }) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const ready = yield* planned.prepare.pipe(Scope.provide(scope), Effect.exit);
    return { ready, close: Scope.close(scope, Exit.void) };
  });

describe("a worker packed onto a hosted machine", () => {
  it.effect("fills one shared machine from a burst of spawns, instead of starting several", () =>
    Effect.gen(function* () {
      const { spawn, startsOf, attachesOf } = yield* setup();
      // Three resolve before any of them goes ahead, as tool calls sent together do.
      const planned = [
        yield* spawn({ shared: true }),
        yield* spawn({ shared: true }),
        yield* spawn({ shared: true }),
      ];
      expect(new Set(planned.map((each) => each?.name)).size).toBe(1);
      for (const each of planned) expect(Exit.isSuccess((yield* prepare(each!)).ready)).toBe(true);
      expect(startsOf()).toHaveLength(1);
      expect(startsOf()[0]?.body["sharing"]).toEqual({ mode: "shared" });
      expect(attachesOf()).toHaveLength(3);
      expect(planned[0]?.placement).toMatchObject({ packing: "shared", shared: true });
      expect(new Set(planned.map((each) => each?.placement.seat)).size).toBe(3);
    }).pipe(Effect.scoped),
  );

  it.effect("starts another shared machine once the first is at its cap", () =>
    Effect.gen(function* () {
      const { spawn } = yield* setup({ cap: 2 });
      const names = [];
      for (let each = 0; each < 5; each += 1) names.push((yield* spawn({ shared: true }))?.name);
      // Two a machine: the fifth spawn opens the third.
      expect(names[0]).toBe(names[1]);
      expect(names[2]).toBe(names[3]);
      expect(new Set(names).size).toBe(3);
    }).pipe(Effect.scoped),
  );

  it.effect("joins a shared machine its workers are on, and counts them against the cap", () =>
    Effect.gen(function* () {
      const placement = { machine: "worker-00000000aa", packing: "shared" as const };
      let threads = [worker("a", "m-worker-00000000aa", placement)];
      const { spawn, online, startsOf } = yield* setup({ cap: 2, threads: () => threads });
      online.set("worker-00000000aa", { id: "m-worker-00000000aa", name: "worker-00000000aa" });
      const joined = yield* spawn({ shared: true });
      expect(joined?.name).toBe("worker-00000000aa");
      yield* (yield* prepare(joined!)).close;
      // With two workers on it, it is full: the next goes to a new machine.
      threads = [...threads, worker("b", "m-worker-00000000aa", placement)];
      const next = yield* spawn({ shared: true });
      expect(next?.name).not.toBe("worker-00000000aa");
      expect(Exit.isSuccess((yield* prepare(next!)).ready)).toBe(true);
      expect(startsOf()).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a spawn off a shared machine started with other picks", () =>
    Effect.gen(function* () {
      const threads = [
        worker("a", "m-worker-00000000aa", {
          machine: "worker-00000000aa",
          packing: "shared",
          picks: { environment: "data" },
        }),
      ];
      const { spawn, online } = yield* setup({ threads: () => threads });
      online.set("worker-00000000aa", { id: "m-worker-00000000aa", name: "worker-00000000aa" });
      expect((yield* spawn({ shared: true }))?.name).not.toBe("worker-00000000aa");
      expect((yield* spawn({ shared: true, environment: "Data" }))?.name).toBe("worker-00000000aa");
    }).pipe(Effect.scoped),
  );

  it.effect("lets the workspace lower the cap, never raise it", () =>
    Effect.gen(function* () {
      const lowered = yield* setup({ cap: 4, charter: { workersPerMachine: 1 } });
      expect((yield* lowered.spawn({ shared: true }))?.name).not.toBe(
        (yield* lowered.spawn({ shared: true }))?.name,
      );
      const raised = yield* setup({ cap: 1, charter: { workersPerMachine: 8 } });
      expect((yield* raised.spawn({ shared: true }))?.name).not.toBe(
        (yield* raised.spawn({ shared: true }))?.name,
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "refuses a named machine that is full, exclusive, another's, or not what is asked",
    () =>
      Effect.gen(function* () {
        const name = "worker-00000000aa";
        const on = (placement: NonNullable<Thread["spawnedBy"]>["placement"], more = {}) =>
          worker("a", `m-${name}`, placement, more);
        const refusal = (threads: Thread[], sandbox: WorkerSandbox, cap = 1) =>
          Effect.gen(function* () {
            const { spawn, online } = yield* setup({ cap, threads: () => threads });
            online.set(name, { id: `m-${name}`, name });
            const exit = yield* Effect.exit(spawn(sandbox));
            return Exit.isFailure(exit) ? String(exit.cause) : "placed";
          });
        expect(
          yield* refusal([on({ machine: name, packing: "own" })], { shareWith: name }),
        ).toMatch(/is for 1 worker and has 1/);
        expect(
          yield* refusal([on({ machine: name, packing: "exclusive" })], { shareWith: name }, 4),
        ).toMatch(/never shared/);
        expect(
          yield* refusal(
            [on({ machine: name }, { spawnedBy: { threadId: "t-other", feature: "f" } })],
            { shareWith: name },
            4,
          ),
        ).toMatch(/isn't yours to place a worker on/);
        expect(
          yield* refusal(
            [on({ machine: name, packing: "own", picks: { environment: "data" } })],
            { shareWith: name, environment: "workspace" },
            4,
          ),
        ).toMatch(/isn't what this worker asks for/);
        // Named with nothing picked, it is taken as it is.
        expect(
          yield* refusal([on({ machine: name, packing: "own" })], { shareWith: name }, 4),
        ).toBe("placed");
      }).pipe(Effect.scoped),
  );

  it.effect("says which environment a worker placed by name is meant for: the machine's own", () =>
    Effect.gen(function* () {
      const name = "worker-00000000aa";
      const threads = [
        worker("a", `m-${name}`, { machine: name, packing: "own", picks: { environment: "data" } }),
      ];
      const { spawn, online, attachesOf } = yield* setup({ threads: () => threads });
      online.set(name, { id: `m-${name}`, name });
      // Named with no environment, the worker takes the machine as it is, and says so: a
      // provider never has to guess which environment it was meant for.
      yield* prepare((yield* spawn({ shareWith: name }))!);
      expect(attachesOf().at(-1)?.body["attach"]).toMatchObject({ environment: "data" });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "takes the provider's refusal of a seat as the last word, and gives the machine back",
    () =>
      Effect.gen(function* () {
        const { spawn, calls } = yield* setup({ refuseSeat: "other_orchestrator" });
        const planned = yield* spawn({ own: true });
        const { ready, close } = yield* prepare(planned!);
        expect(Exit.isFailure(ready) && String(ready.cause)).toMatch(
          /another orchestrator's workers/,
        );
        // The machine this try started holds nobody: it is stopped, not left running.
        expect(calls.some((each) => each.call === "stop")).toBe(true);
        yield* close;
      }).pipe(Effect.scoped),
  );

  it.effect("gives up a seat whose worker never came to be, and keeps one whose worker did", () =>
    Effect.gen(function* () {
      let threads: Thread[] = [];
      const { spawn, seated } = yield* setup({ threads: () => threads });
      const lost = yield* spawn({ own: true }, "Lost");
      const first = yield* prepare(lost!);
      expect(seated.get(lost!.name)).toEqual([lost!.placement.seat]);
      // The spawn failed after its seat was taken: no worker carries it.
      yield* first.close;
      expect(seated.get(lost!.name)).toEqual([]);

      const kept = yield* spawn({ own: true }, "Kept");
      const second = yield* prepare(kept!);
      threads = [worker("k", `m-${kept!.name}`, kept!.placement)];
      yield* second.close;
      expect(seated.get(kept!.name)).toEqual([kept!.placement.seat]);
    }).pipe(Effect.scoped),
  );

  it.effect("says a machine of its own is exclusive only when asked", () =>
    Effect.gen(function* () {
      const { spawn, startsOf } = yield* setup();
      const open = yield* spawn({ own: true }, "Open");
      const closed = yield* spawn({ own: true, exclusive: true }, "Closed");
      yield* prepare(open!);
      yield* prepare(closed!);
      expect(startsOf().map((each) => each.body["sharing"])).toEqual([
        { mode: "own" },
        { mode: "exclusive" },
      ]);
      expect(open?.placement.packing).toBe("own");
      expect(closed?.placement.packing).toBe("exclusive");
      const exit = yield* Effect.exit(spawn({ shared: true, exclusive: true }));
      expect(Exit.isFailure(exit) && String(exit.cause)).toMatch(/machine of its own/);
    }).pipe(Effect.scoped),
  );

  it.effect("asks a provider that keeps no seats for none, and sends it no new field", () =>
    Effect.gen(function* () {
      const { spawn, calls, startsOf } = yield* setup({ seats: false });
      const planned = yield* spawn({ shared: true });
      expect(Exit.isSuccess((yield* prepare(planned!)).ready)).toBe(true);
      expect(startsOf()[0]?.body).not.toHaveProperty("sharing");
      expect(calls.some((each) => each.call === "workers" || each.call === "machines")).toBe(false);
      expect(planned?.placement).toMatchObject({ packing: "shared" });
      // Its seat is this Gram's own name for its place, told to no provider that keeps none.
      expect(planned?.placement.seat).toBeDefined();
      // Its own cap still holds: four to a machine, then another.
      const names = new Set([planned?.name]);
      for (let each = 0; each < 4; each += 1) names.add((yield* spawn({ shared: true }))?.name);
      expect(names.size).toBe(2);
    }).pipe(Effect.scoped),
  );
});

describe("a machine named for a worker, with no way round its checks", () => {
  const name = "worker-00000000aa";
  const input = { title: "Named", feature: "f", project: "shop", machine: name };

  it.effect("holds `machine` naming a workers' machine to what `shareWith` is held to", () =>
    Effect.gen(function* () {
      const refusal = (threads: Thread[]) =>
        Effect.gen(function* () {
          const { plan, online } = yield* setup({ threads: () => threads });
          online.set(name, { id: `m-${name}`, name });
          const exit = yield* Effect.exit(plan(CALLER, input, undefined));
          return Exit.isFailure(exit) ? String(exit.cause) : exit.value;
        });
      // Another orchestrator's machine, with no worker of the caller's on it.
      expect(
        yield* refusal([
          worker("b", `m-${name}`, { machine: name, packing: "exclusive" }, {
            spawnedBy: { threadId: "t-other", feature: "f" },
          } as never),
        ]),
      ).toMatch(/isn't yours to place a worker on/);
      // The caller's own exclusive machine: never shared, by this door either.
      expect(
        yield* refusal([worker("a", `m-${name}`, { machine: name, packing: "exclusive" })]),
      ).toMatch(/never shared/);
      // Its own machine with room: placed as a named share, with a seat.
      expect(
        yield* refusal([worker("a", `m-${name}`, { machine: name, packing: "own" })]),
      ).toMatchObject({ name, placement: { packing: "named" } });
      // A machine that isn't a workers' machine is not the planner's: placed as before.
      const { plan } = yield* setup();
      expect(yield* plan(CALLER, { ...input, machine: "build-box" }, undefined)).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("checks the cap again as the spawn goes ahead, after any approval", () =>
    Effect.gen(function* () {
      const placement = { machine: name, packing: "shared" as const };
      let threads = [worker("a", `m-${name}`, placement)];
      const { spawn, online } = yield* setup({ cap: 2, threads: () => threads });
      online.set(name, { id: `m-${name}`, name });
      const planned = yield* spawn({ shareWith: name });
      // While its approval card is open, another worker lands on the machine.
      threads = [...threads, worker("b", `m-${name}`, placement)];
      const { ready, close } = yield* prepare(planned!);
      expect(Exit.isFailure(ready) && String(ready.cause)).toMatch(/is for 2 workers and has 2/);
      yield* close;
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a spawn's seat known to the release pass until its try is over", () =>
    Effect.gen(function* () {
      const { spawn } = yield* setup();
      const planned = yield* spawn({ own: true });
      const seat = planned!.placement.seat!;
      // No thread is on the machine yet: only this says a worker is on its way there.
      expect(reservedSeats(planned!.name)).toContain(seat);
      expect([...withReserved({ live: new Set(), any: false }, [seat]).live]).toEqual([seat]);
      const { close } = yield* prepare(planned!);
      expect(reservedSeats(planned!.name)).toContain(seat);
      yield* close;
      expect(reservedSeats(planned!.name)).not.toContain(seat);
    }).pipe(Effect.scoped),
  );
});

const failure = <A>(exit: Exit.Exit<A, unknown>) =>
  Exit.isFailure(exit) ? String(exit.cause) : "placed";

/** A planner whose first spawn, under one project, feature and title, has its worker placed. */
const titled = (sandbox: WorkerSandbox, options: Parameters<typeof setup>[0] = {}) =>
  Effect.gen(function* () {
    let threads: Thread[] = [];
    const made = yield* setup({ ...options, threads: () => threads });
    const first = yield* made.spawn(sandbox, "Same title");
    expect(Exit.isSuccess((yield* prepare(first!)).ready)).toBe(true);
    threads = [worker("a", `m-${first!.name}`, first!.placement)];
    return { ...made, first: first! };
  });

describe("one decision for every way onto a workers' machine", () => {
  const name = "worker-00000000aa";
  const id = `m-${name}`;
  const OTHER = "t-other" as ThreadId;

  it.effect("takes no other spelling of a workers' machine's name for the machine", () =>
    Effect.gen(function* () {
      // Another orchestrator's exclusive machine, with its worker on it.
      const threads = [
        worker("b", id, { machine: name, packing: "exclusive" }, {
          spawnedBy: { threadId: OTHER, feature: "f", placement: { machine: name } },
        } as never),
      ];
      const { plan, online, claims, calls } = yield* setup({ threads: () => threads });
      online.set(name, { id, name });
      claims.claim(name, { orchestrator: OTHER, mode: "exclusive", picks: {}, at: 1 });
      const input = { title: "Named", feature: "f", project: "shop" };
      // Its exact name and its id both come to the one decision, which refuses.
      for (const machine of [name, id])
        expect(failure(yield* Effect.exit(plan(CALLER, { ...input, machine }, undefined)))).toMatch(
          /isn't yours to place a worker on/,
        );
      // Any other spelling names no machine at all: the planner has none to place on, and the
      // spawn's own lookup (the same resolver) refuses it as unknown.
      for (const machine of [name.toUpperCase(), id.toUpperCase(), ` ${name}x`]) {
        expect(yield* plan(CALLER, { ...input, machine }, undefined)).toBeUndefined();
        expect(machineNamedIn([{ id, name, onDemand: "worker" }], machine)).toMatchObject({
          kind: "refused",
          code: "unknown_machine",
        });
      }
      // Whatever led a spawn to the machine, making the worker's folder there is decided again:
      // a spawn that comes with no plan of its own is a worker named there, held to the same.
      expect(failure(yield* Effect.exit(plan.admission.confirm(CALLER, id, undefined)))).toMatch(
        /isn't yours to place a worker on/,
      );
      expect(calls.some((each) => each.call === "workers")).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("gives a machine of its own to one worker: never one that carries another", () =>
    Effect.gen(function* () {
      // An exclusive spawn that works out the same name is not put on the first's ordinary one.
      const own = yield* titled({ own: true });
      expect(
        failure(yield* Effect.exit(own.spawn({ own: true, exclusive: true }, "Same title"))),
      ).toMatch(/can't become one worker's alone/);
      // The other way round, on a provider that keeps no seats: the exclusive worker gets no
      // sibling.
      const exclusive = yield* titled({ own: true, exclusive: true }, { seats: false });
      expect(failure(yield* Effect.exit(exclusive.spawn({ own: true }, "Same title")))).toMatch(
        /never shared/,
      );
      // Two ordinary ones: the second isn't given the first's machine as its own, cap or no cap.
      for (const cap of [1, 4]) {
        const twice = yield* titled({ own: true }, { cap });
        expect(failure(yield* Effect.exit(twice.spawn({ own: true }, "Same title")))).toMatch(
          /isn't given it as its own/,
        );
        expect(twice.startsOf()).toHaveLength(1);
        // Named outright, it is a worker placed there by choice, counted against the cap.
        expect(failure(yield* Effect.exit(twice.spawn({ shareWith: twice.first.name })))).toMatch(
          cap === 1 ? /is for 1 worker and has 1/ : /placed/,
        );
      }
      // The folder's making decides it too, for a spawn that reaches it by another road.
      expect(
        failure(
          yield* Effect.exit(
            own.plan.admission.confirm(CALLER, `m-${own.first.name}`, {
              machine: own.first.name,
              packing: "own",
            }),
          ),
        ),
      ).toMatch(/isn't given it as its own/);
    }).pipe(Effect.scoped),
  );

  it.effect("lets a retry of one request back to its own machine, and its worker's seat", () =>
    Effect.gen(function* () {
      let threads: Thread[] = [];
      const { plan, attachesOf } = yield* setup({ threads: () => threads });
      const input = { title: "Once", feature: "f", project: "shop", clientRequestId: "once-1" };
      const first = yield* plan(CALLER, input, { own: true, exclusive: true });
      // A retry that comes while the first try still places holds the same place, not another.
      const meanwhile = yield* plan(CALLER, input, { own: true, exclusive: true });
      expect(meanwhile?.placement.seat).toBe(first?.placement.seat);
      expect(Exit.isSuccess((yield* prepare(first!)).ready)).toBe(true);
      threads = [worker("a", `m-${first!.name}`, first!.placement)];
      // And one that comes once the worker exists: the worker is not in its own way.
      const retry = yield* plan(CALLER, input, { own: true, exclusive: true });
      expect(retry?.name).toBe(first?.name);
      expect(Exit.isSuccess((yield* prepare(retry!)).ready)).toBe(true);
      const seats = attachesOf().map((each) => (each.body["attach"] as { worker: string }).worker);
      expect(new Set(seats)).toEqual(new Set([first!.placement.seat]));
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a machine its orchestrator's when one of its workers is taken on", () =>
    Effect.gen(function* () {
      const placement = { machine: name, packing: "own" as const, seat: "s-a" };
      let threads = [worker("a", id, placement)];
      const { plan, online, claims } = yield* setup({ threads: () => threads });
      online.set(name, { id, name });
      const input = { title: "Next", feature: "f", project: "shop" };
      // With another of the first orchestrator's workers there, it isn't taken on by another:
      // the adoption itself would put two orchestrators' workers on one machine.
      threads = [...threads, worker("a2", id, { machine: name, packing: "named" })];
      expect(
        failure(
          yield* Effect.exit(plan.admission.adopting(threads[0]!, OTHER, threads[0]!.checkout)),
        ),
      ).toMatch(/shared within one orchestrator only/);
      // Alone there, it may be. The machine's claim was written down as it changed hands.
      threads = [threads[0]!];
      expect(
        yield* plan.admission.adopting(threads[0]!, OTHER, threads[0]!.checkout),
      ).toBeUndefined();
      expect(claims.get(name)?.orchestrator).toBe(CALLER);
      // As the adoption leaves it: the other orchestrator's worker, with no placement of its own.
      threads = [worker("a", id, undefined, { spawnedBy: { threadId: OTHER, feature: "f" } })];
      // Its new orchestrator places nothing beside it: the machine isn't that orchestrator's.
      for (const sandbox of [{ shareWith: name }, { shareWith: "a" }])
        expect(failure(yield* Effect.exit(plan(OTHER, input, sandbox)))).toMatch(
          /isn't yours to place a worker on|is not one of your workers/,
        );
      expect(
        failure(yield* Effect.exit(plan(OTHER, { ...input, machine: name }, undefined))),
      ).toMatch(/isn't yours to place a worker on/);
      // Nor does the one it was started for, while another's worker is on it.
      expect(failure(yield* Effect.exit(plan(CALLER, input, { shareWith: name })))).toMatch(
        /carries another orchestrator's worker/,
      );
      // Taken back by the machine's own orchestrator, it is placed as any worker named there.
      expect(
        failure(
          yield* Effect.exit(plan.admission.adopting(threads[0]!, CALLER, threads[0]!.checkout)),
        ),
      ).toBe("placed");
      // A thread is never moved onto a workers' machine by being taken on.
      const elsewhere = worker("e", "m-elsewhere", undefined);
      expect(
        failure(
          yield* Effect.exit(
            plan.admission.adopting(elsewhere, CALLER, {
              ...elsewhere.checkout,
              hostId: id,
            } as never),
          ),
        ),
      ).toMatch(/isn't moved onto one/);
    }).pipe(Effect.scoped),
  );

  it.effect("counts a finished worker's place as taken, so one that resumes finds it its own", () =>
    Effect.gen(function* () {
      const placement = { machine: name, packing: "shared" as const };
      // With a cap of two: A's work is over, B keeps the machine at work. Whatever a ledger says
      // of A, it is open, and a message puts it back to work: no ledger is asked.
      const threads = [worker("a", id, placement), worker("b", id, placement)];
      const { plan: made, online } = yield* setup({ cap: 2, threads: () => threads });
      online.set(name, { id, name });
      const input = { title: "C", feature: "f", project: "shop" };
      // C is not packed into A's place, by name or by the pool.
      expect(failure(yield* Effect.exit(made(CALLER, input, { shareWith: name })))).toMatch(
        /is for 2 workers and has 2/,
      );
      expect((yield* made(CALLER, input, { shared: true }))?.name).not.toBe(name);
      // Once A is archived its place is free.
      threads[0] = { ...threads[0]!, parked: true };
      expect((yield* made(CALLER, input, { shareWith: name }))?.name).toBe(name);
    }).pipe(Effect.scoped),
  );
});

describe("round 4: the same decision on every road, and nothing counted twice", () => {
  const name = "worker-00000000fe";
  const id = `m-${name}`;
  const input = { title: "Next", feature: "f", project: "shop" };

  it.effect("admits the first spawn onto its own machine where the provider keeps no seats", () =>
    Effect.gen(function* () {
      for (const sandbox of [{ own: true }, { own: true, exclusive: true }]) {
        let threads: Thread[] = [];
        const { spawn, plan, calls } = yield* setup({ seats: false, threads: () => threads });
        const planned = yield* spawn(sandbox);
        expect(Exit.isSuccess((yield* prepare(planned!)).ready)).toBe(true);
        // As the worker's folder is made, the spawn is decided again with its own seat, which
        // its placement carries: its own reservation is not another worker.
        const made = yield* Effect.exit(
          plan.admission.confirm(CALLER, `m-${planned!.name}`, planned!.placement),
        );
        expect(failure(made)).toBe("placed");
        expect(Exit.isSuccess(made) && made.value?.seat).toBe(planned!.placement.seat);
        // With its worker made, the reservation and the worker are one place, not two.
        threads = [worker("a", `m-${planned!.name}`, planned!.placement)];
        expect(failure(yield* Effect.exit(spawn({ shareWith: planned!.name })))).toMatch(
          sandbox.exclusive === true ? /never shared/ : /placed/,
        );
        expect(calls.some((each) => each.call === "workers" || each.call === "machines")).toBe(
          false,
        );
      }
    }).pipe(Effect.scoped),
  );

  it.effect("keeps an exclusive machine its first worker's once it stands empty", () =>
    Effect.gen(function* () {
      let threads: Thread[] = [];
      const made = yield* setup({ threads: () => threads });
      const first = yield* made.spawn({ own: true, exclusive: true }, "Same title");
      expect(Exit.isSuccess((yield* prepare(first!)).ready)).toBe(true);
      expect(made.claims.get(first!.name)).toMatchObject({ seat: first!.placement.seat });
      // Its worker is archived: nobody is on the machine now.
      threads = [worker("a", `m-${first!.name}`, first!.placement, { parked: true })];
      // Another exclusive spawn that works out the same name does not come to its disk.
      expect(
        failure(yield* Effect.exit(made.spawn({ own: true, exclusive: true }, "Same title"))),
      ).toMatch(/never shared/);
      const another = { machine: first!.name, packing: "exclusive" as const, seat: "another" };
      expect(
        failure(
          yield* Effect.exit(made.plan.admission.confirm(CALLER, `m-${first!.name}`, another)),
        ),
      ).toMatch(/never shared/);
      // The worker it was asked for comes back to it.
      expect(yield* made.plan.admission.reviving(threads[0]!)).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("decides an archived worker's return like any placement", () =>
    Effect.gen(function* () {
      const placement = (seat: string) => ({ machine: name, packing: "shared" as const, seat });
      // Cap two. A was archived, and C was packed beside B in the place A gave up.
      const a = worker("a", id, placement("sa"), { parked: true });
      let threads = [a, worker("b", id, placement("sb")), worker("c", id, placement("sc"))];
      const { plan, online, claims } = yield* setup({ cap: 2, threads: () => threads });
      online.set(name, { id, name });
      expect(yield* plan.admission.reviving(a)).toMatch(/is for 2 workers and has 2/);
      // With C archived in turn there is room, and A's place is held from the decision on:
      // a spawn that comes before A's thread is stored as unarchived finds the machine full.
      threads = [a, threads[1]!, { ...threads[2]!, parked: true }];
      expect(yield* plan.admission.reviving(a)).toBeUndefined();
      expect(failure(yield* Effect.exit(plan(CALLER, input, { shareWith: name })))).toMatch(
        /is for 2 workers and has 2/,
      );
      // A thread that is no orchestrator's any more comes back only to a machine nobody is on.
      const detached = { ...a, spawnedBy: undefined } as never as Thread;
      expect(yield* plan.admission.reviving(detached)).toMatch(
        /shared within one orchestrator only/,
      );
      expect(claims.get(name)?.orchestrator).toBe(CALLER);
      // Archived while its turn still runs, a worker keeps its place until that ends.
      const busy = "worker-00000000fb";
      const there = (title: string) => [
        worker("b", `m-${busy}`, { ...placement("sb"), machine: busy }, { parked: true, title }),
        worker("c", `m-${busy}`, { ...placement("sc"), machine: busy }),
      ];
      for (const [title, outcome] of [
        ["Worker b, mid-turn", /is for 2 workers and has 2/],
        ["Worker b", /placed/],
      ] as const) {
        const made = yield* setup({ cap: 2, threads: () => there(title) });
        made.online.set(busy, { id: `m-${busy}`, name: busy });
        expect(failure(yield* Effect.exit(made.spawn({ shareWith: busy })))).toMatch(outcome);
      }
      // A thread on no workers' machine is none of this.
      expect(yield* plan.admission.reviving(worker("e", "m-elsewhere", undefined))).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("waits out a release on its way on every road to the machine", () =>
    Effect.gen(function* () {
      type Planner = Effect.Success<ReturnType<typeof setup>>["plan"];
      const roads: Record<
        string,
        (plan: Planner, machine: string, archived: Thread) => Effect.Effect<unknown, unknown>
      > = {
        "the folder's making, with no plan": (plan, machine) =>
          plan.admission.confirm(CALLER, `m-${machine}`, undefined),
        "a spawn that names the machine": (plan, machine) =>
          plan(CALLER, input, { shareWith: machine }),
        "a spawn by `machine`": (plan, machine) => plan(CALLER, { ...input, machine }, undefined),
        "an archived worker's return": (plan, _machine, archived) =>
          plan.admission.reviving(archived),
      };
      for (const [index, [road, placing]] of Object.entries(roads).entries()) {
        // A machine of its own a road: seats held are seen across the process.
        const machine = `worker-0000000${index}fd`;
        const placement = { machine, packing: "own" as const, seat: "sa" };
        const threads = [
          worker("a", `m-${machine}`, placement),
          worker("z", `m-${machine}`, { ...placement, seat: "sz" }, { parked: true }),
        ];
        const { plan, online } = yield* setup({ threads: () => threads });
        online.set(machine, { id: `m-${machine}`, name: machine });
        // A release of the machine is on its way (nobody held a seat when it began).
        const release = releaseFence.begin(machine);
        expect(release, road).toBeDefined();
        const fiber = yield* Effect.forkScoped(Effect.exit(placing(plan, machine, threads[1]!)));
        for (let each = 0; each < 20; each += 1) yield* Effect.yieldNow;
        // Its seat is held, so the pass takes the release back; until it has, nothing is placed.
        expect(fiber.pollUnsafe(), road).toBeUndefined();
        expect(release!.reservedNow(), road).toBe(true);
        release!.done();
        expect(Exit.isSuccess(yield* Fiber.join(fiber)), road).toBe(true);
      }
    }).pipe(Effect.scoped),
  );
});

describe("where a worker goes when its spawn names no place", () => {
  it.effect("is its orchestrator's machine unless the workspace says otherwise", () =>
    Effect.gen(function* () {
      const { spawn, calls } = yield* setup();
      expect(yield* spawn(undefined)).toBeUndefined();
      expect(yield* spawn({ reason: "Just a note." })).toBeUndefined();
      expect(calls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("follows the workspace's default, which a spawn still overrides", () =>
    Effect.gen(function* () {
      const shared = yield* setup({ charter: { workerPacking: "shared" } });
      expect((yield* shared.spawn(undefined))?.placement.packing).toBe("shared");
      expect((yield* shared.spawn({ own: true }))?.placement.packing).toBe("own");
      expect(yield* shared.spawn({ own: false })).toBeUndefined();
      const own = yield* setup({ charter: { workerPacking: "own" } });
      expect((yield* own.spawn(undefined))?.placement.packing).toBe("own");
      expect((yield* own.spawn({ shared: true }))?.placement.packing).toBe("shared");
    }).pipe(Effect.scoped),
  );

  it.effect("stays on the orchestrator's machine where no provider offers any", () =>
    Effect.gen(function* () {
      const { spawn } = yield* setup({ charter: { workerPacking: "shared" }, offered: false });
      expect(yield* spawn(undefined)).toBeUndefined();
      // Asked for outright, it is refused as it always was.
      const exit = yield* Effect.exit(spawn({ shared: true }));
      expect(Exit.isFailure(exit) && String(exit.cause)).toMatch(/can't have machines/);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to name two places at once", () =>
    Effect.gen(function* () {
      const { spawn } = yield* setup();
      for (const sandbox of [
        { own: true, shared: true },
        { shared: true, shareWith: "worker-00000000aa" },
        { own: false, shared: true },
      ]) {
        const exit = yield* Effect.exit(spawn(sandbox));
        expect(Exit.isFailure(exit) && String(exit.cause)).toMatch(/names one place/);
      }
    }).pipe(Effect.scoped),
  );
});
