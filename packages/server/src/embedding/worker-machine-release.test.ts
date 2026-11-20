import { describe, expect, it } from "@effect/vitest";
import type { HostId, Thread, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { makeOnDemandHosts } from "./on-demand.ts";
import {
  releaseDecisions,
  tellRelease,
  WORKER_RELEASE_SETTLE_MS,
  workerMachineWork,
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
type Placed = Pick<Thread, "id" | "checkout" | "currentCheckout" | "spawnedBy" | "parked">;
const on = (id: string, hostId: string, extra: Partial<Placed> = {}): Placed =>
  ({
    id: id as ThreadId,
    checkout: { path: `/w/${id}`, hostId: hostId as HostId },
    spawnedBy: { threadId: "orch" as ThreadId, feature: "f" },
    ...extra,
  }) as Placed;

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
      [machine("aaaa"), machine("bbbb", { onlineSince: now - 60_000 })],
      [on("t1", "aaaa"), on("t2", "bbbb")],
      new Set(),
      now,
      new Map(),
    );
    // Both at work, the one that has only just come back included: told so at once.
    expect(decided.map(({ machine: m, released }) => [m.id, released])).toEqual([
      ["aaaa", false],
      ["bbbb", false],
    ]);
  });

  it("judges a machine's work over only once it has settled, and says nothing twice", () => {
    const told = new Map([["cccc", true]]);
    const decided = releaseDecisions(
      [machine("aaaa", { onlineSince: now - 60_000 }), machine("bbbb"), machine("cccc")],
      [],
      new Set(),
      now,
      told,
    );
    // aaaa has just come online: not yet. cccc was told already.
    expect(decided.map(({ machine: m, released }) => [m.id, released])).toEqual([["bbbb", true]]);
  });
});
