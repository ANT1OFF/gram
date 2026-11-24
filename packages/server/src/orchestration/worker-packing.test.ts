// How tightly an orchestrator's workers are packed onto its hosted machines: the cap, the pool a
// `shared` spawn joins, the seats a provider keeps, and the workspace's default. A fake app
// answers for a hosted server: no network, and no machine is ever started.

import { describe, expect, it } from "@effect/vitest";
import type { OrchestratorCharter, Thread, ThreadId, WorkspaceId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { signedInSource, type WorkerMachinePortShape } from "../embedding/signed-in-workers.ts";
import { makeWorkerSandbox } from "./worker-sandbox.ts";
import {
  machineCap,
  makeSeatHolds,
  packingOn,
  picksMismatch,
  picksOn,
  reservedSeats,
  workersOnMachine,
} from "./worker-packing.ts";
import { withReserved } from "../embedding/worker-seat-upkeep.ts";
import type { WorkerSandbox } from "./tool-inputs.ts";

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
  it("counts an orchestrator's open workers there that aren't finished or parked", () => {
    const threads = [
      worker("a", "m-1", { machine: "worker-1", packing: "shared" }),
      worker("b", "m-1", { machine: "worker-1", packing: "shared" }),
      worker("done", "m-1", { machine: "worker-1", packing: "shared" }),
      worker("parked", "m-1", { machine: "worker-1" }, { parked: true }),
      worker("elsewhere", "m-2", { machine: "worker-2" }),
    ];
    expect(
      workersOnMachine(threads, "m-1", new Set(["done" as ThreadId])).map((each) => each.id),
    ).toEqual(["a", "b"]);
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
    const plan = yield* makeWorkerSandbox({
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
    return { spawn, plan, calls, startsOf, attachesOf, online, seated };
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
        ).toMatch(/no worker of yours/);
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
      expect(planned?.placement.seat).toBeUndefined();
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
      ).toMatch(/no worker of yours/);
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
