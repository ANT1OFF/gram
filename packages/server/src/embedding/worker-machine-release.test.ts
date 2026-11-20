import { describe, expect, it } from "@effect/vitest";
import type { HostId, Thread, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { makeOnDemandHosts } from "./on-demand.ts";

import {
  recordTold,
  releaseDecisions,
  tellRelease,
  WORKER_RELEASE_SETTLE_MS,
  workerMachineWork,
  releasableWorkers,
} from "./worker-machine-release.ts";

const now = 10 * WORKER_RELEASE_SETTLE_MS;
const machine = (id: string, extra: object = {}) => ({
  id,
  name: `worker-${id.padEnd(10, "0")}`,
  owner: "ada",
  onDemand: "worker",
  onlineSince: now - 2 * WORKER_RELEASE_SETTLE_MS,
  ...extra,
});
/** A machine from a hosted server the desktop app is signed in to, rather than an embedder's. */
const relayed = (id: string, extra: object = {}) =>
  machine(id, { owner: undefined, via: "https://hosted.example.test", ...extra });
type Placed = Pick<Thread, "id" | "checkout" | "currentCheckout" | "spawnedBy" | "parked">;
const on = (id: string, hostId: string, extra: Partial<Placed> = {}): Placed =>
  ({
    id: id as ThreadId,
    checkout: { path: `/w/${id}`, hostId: hostId as HostId },
    spawnedBy: { threadId: "orch" as ThreadId, feature: "f" },
    ...extra,
  }) as Placed;

/** A worker as the ledger lists it, by its state and its thread's status. */
const worker = (threadId: string, state: string, status: string) => ({ threadId, state, status });

describe("a worker machine's work", () => {
  it("is over once every thread placed on it is finished, or closed", () => {
    const work = workerMachineWork(
      [machine("aaaa"), machine("bbbb"), machine("cccc")],
      [on("t1", "aaaa"), on("t2", "aaaa"), on("t3", "bbbb")],
      new Set(["t1", "t3"] as ThreadId[]),
      now,
    );
    expect(work.map(({ machine: m, over }) => [m.id, over])).toEqual([
      ["aaaa", false],
      ["bbbb", true],
      // Nothing open is placed on it any more: its workers were closed with their worktrees.
      ["cccc", true],
    ]);
  });

  it("follows a moved checkout, and a parked thread nobody spawned is over", () => {
    const moved = on("t1", "aaaa", {
      currentCheckout: { path: "/w/x", hostId: "bbbb" as HostId },
    } as Partial<Placed>);
    const { spawnedBy: _spawned, ...bare } = on("t2", "cccc", { parked: true });
    const own = bare as Placed;
    const work = workerMachineWork(
      [machine("aaaa"), machine("bbbb"), machine("cccc")],
      [moved, own],
      new Set(),
      now,
    );
    expect(work.map(({ over }) => over)).toEqual([true, false, true]);
  });

  it("leaves a new machine, one not a worker's and one with no owner unjudged", () => {
    expect(
      workerMachineWork(
        [
          machine("aaaa", { onlineSince: now - 60_000 }),
          machine("bbbb", { onDemand: "personal" }),
          machine("cccc", { owner: undefined }),
        ],
        [],
        new Set(),
        now,
      ),
    ).toEqual([]);
  });

  it.live("is told to the provider, with whether it is released", () =>
    Effect.gen(function* () {
      const got: unknown[] = [];
      const server = createServer((request, response) => {
        let text = "";
        request.on("data", (chunk) => (text += chunk));
        request.on("end", () => {
          got.push({ path: request.url, body: JSON.parse(text) });
          response.writeHead(204);
          response.end();
        });
      });
      yield* Effect.promise(() => new Promise<void>((done) => server.listen(0, "127.0.0.1", done)));
      const { port } = server.address() as AddressInfo;
      const hosts = makeOnDemandHosts({ url: `http://127.0.0.1:${port}`, token: "t" });
      yield* tellRelease(hosts, machine("aaaa"), true);
      yield* tellRelease(hosts, machine("aaaa"), false);
      yield* Effect.promise(() => new Promise<void>((done) => server.close(() => done())));
      expect(got).toEqual([
        {
          path: "/hosts/release",
          body: {
            kind: "worker",
            owner: "ada",
            name: "worker-aaaa000000",
            released: true,
            reason: "finished",
          },
        },
        {
          path: "/hosts/release",
          body: {
            kind: "worker",
            owner: "ada",
            name: "worker-aaaa000000",
            released: false,
            reason: "working",
          },
        },
      ]);
    }),
  );

  it("tells a machine at work it is working once each run, even with nothing kept of an earlier release", () => {
    // After a restart nothing is kept of what was told; the server may still hold a release.
    const decided = releaseDecisions(
      [relayed("aaaa"), relayed("bbbb", { onlineSince: now - 60_000 })],
      [on("t1", "aaaa"), on("t2", "bbbb")],
      new Set(),
      now,
      new Map<string, { released: boolean; at: number }>(),
    );
    // Both at work, the one that has only just come back included: told so at once.
    expect(decided.map(({ machine: m, released }) => [m.id, released])).toEqual([
      ["aaaa", false],
      ["bbbb", false],
    ]);
  });

  it("judges a machine's work over only once it has settled, and says nothing twice", () => {
    const told = new Map([["cccc", { released: true, at: now - 60_000 }]]);
    const decided = releaseDecisions(
      [relayed("aaaa", { onlineSince: now - 60_000 }), relayed("bbbb"), relayed("cccc")],
      [],
      new Set(),
      now,
      told,
    );
    // aaaa has just come online: not yet. cccc was told already.
    expect(decided.map(({ machine: m, released }) => [m.id, released])).toEqual([["bbbb", true]]);
  });

  it("tells an embedder's provider of a machine only what changed, once it has settled", () => {
    const decided = releaseDecisions(
      [
        // Never told, at work: nothing to take back.
        machine("aaaa"),
        // Just online, at work: not yet.
        machine("bbbb", { onlineSince: now - 60_000 }),
        // Told released two hours ago, and still over: its provider keeps what it was told.
        machine("cccc"),
        // Told released, and at work again: told it is working.
        machine("dddd"),
      ],
      [on("t1", "aaaa"), on("t2", "bbbb"), on("t4", "dddd")],
      new Set(),
      now,
      new Map([
        [machine("cccc").name, { released: true, at: now - 2 * 60 * 60_000 }],
        [machine("dddd").name, { released: true, at: now - 60_000 }],
      ]),
    );
    expect(decided.map(({ machine: m, released }) => [m.id, released])).toEqual([["dddd", false]]);
  });

  it("tells an embedder's provider a take-back again on every pass until it is taken", () => {
    // Told released; a worker is at work there again; the take-back fails at the provider.
    const told = new Map([[machine("aaaa").name, { released: true, at: now - 60_000 }]]);
    const pass = () =>
      releaseDecisions([machine("aaaa")], [on("t1", "aaaa")], new Set(), now, told);
    expect(pass().map(({ released }) => released)).toEqual([false]);
    recordTold(told, machine("aaaa"), false, false, now);
    // Still held released there: asked again, never left to its reclaim.
    expect(pass().map(({ released }) => released)).toEqual([false]);
    recordTold(told, machine("aaaa"), false, true, now);
    expect(pass()).toEqual([]);
    // Its host came back under another key, and so another id: still the machine told.
    told.set(machine("aaaa").name, { released: true, at: now });
    const rekeyed = machine("eeee", { name: machine("aaaa").name });
    expect(
      releaseDecisions([rekeyed], [on("t1", "eeee")], new Set(), now, told).map(
        ({ released }) => released,
      ),
    ).toEqual([false]);
  });

  it("judges an embedder's machine by the workers the ledger reads finished, as it always has", () => {
    // Merged, its turn still running: finished as the ledger reads it, though not releasable.
    const placed = [on("t-running", "aaaa"), on("t-running", "bbbb")];
    const decided = releaseDecisions(
      [machine("aaaa"), relayed("bbbb")],
      placed,
      new Set(),
      now,
      new Map(),
      new Set(["t-running" as ThreadId]),
    );
    // The embedder's is released; the hosted server's is kept at work.
    expect(decided.map(({ machine: m, released }) => [m.id, released])).toEqual([
      ["aaaa", true],
      ["bbbb", false],
    ]);
  });

  it("keeps a worker whose pull request merged but whose turn still runs at work", () => {
    const released = releasableWorkers([
      {
        workers: [worker("t-running", "merged", "running"), worker("t-done", "merged", "idle")],
      },
    ] as never);
    expect([...released]).toEqual(["t-done"]);
  });

  it("tells again, after a while, a release a reuse since may have taken back", () => {
    // Told released two hours ago; a reuse that failed since took the release back there.
    const decided = releaseDecisions(
      [relayed("aaaa")],
      [],
      new Set(),
      now,
      new Map([["aaaa", { released: true, at: now - 2 * 60 * 60_000 }]]),
    );
    expect(decided.map(({ released }) => released)).toEqual([true]);
    // Told a minute ago: not again.
    expect(
      releaseDecisions(
        [relayed("aaaa")],
        [],
        new Set(),
        now,
        new Map([["aaaa", { released: true, at: now - 60_000 }]]),
      ),
    ).toEqual([]);
  });
});
