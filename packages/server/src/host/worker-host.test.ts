import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostId, LOCAL_HOST_ID } from "@gram/contracts";
import { describe, expect, it } from "@effect/vitest";
import { GitStateRuntime, ProcLive, Worktrees } from "@gram/git";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { CheckoutService } from "../runtime/hooks.ts";
import { HostTerminals } from "../terminal/host-terminals.ts";
import type { Terminals } from "../terminal/terminals.ts";
import { type WorkerHost, WorkerHosts } from "./worker-host.ts";

const Agents = Layer.mergeAll(AgentHosts.layerNone, CheckoutService.layerNoGit);
const Local = WorkerHosts.layerLocalForTests.pipe(Layer.provideMerge(Agents));

// Stand-ins: only their identity is checked, so nothing on them is called.
const worktrees = {} as Worktrees["Service"];
const gitState = {} as GitStateRuntime["Service"];
const terminals = {} as Terminals;
const Machine = Layer.mergeAll(
  Agents,
  Layer.succeed(Worktrees, worktrees),
  Layer.succeed(GitStateRuntime, gitState),
  Layer.succeed(HostTerminals, terminals),
  ProcLive,
);

describe("WorkerHosts", () => {
  it.effect("the local host is this machine's agents and checkouts, under `local`", () =>
    Effect.gen(function* () {
      const hosts = yield* WorkerHosts;
      expect(hosts.local.id).toBe(LOCAL_HOST_ID);
      expect(hosts.local.sessions).toBe(yield* AgentHosts);
      expect(hosts.local.checkouts).toBe(yield* CheckoutService);
      expect(yield* hosts.get(LOCAL_HOST_ID)).toBe(hosts.local);
    }).pipe(Effect.provide(Local)),
  );

  it.effect("a record with no host is on this machine", () =>
    Effect.gen(function* () {
      const hosts = yield* WorkerHosts;
      expect(yield* hosts.of({})).toBe(hosts.local);
      expect(yield* hosts.of({ hostId: LOCAL_HOST_ID })).toBe(hosts.local);
    }).pipe(Effect.provide(Local)),
  );

  it.effect("a machine that isn't paired is unavailable, never this one", () =>
    Effect.gen(function* () {
      const hosts = yield* WorkerHosts;
      const error = yield* hosts.of({ hostId: HostId.make("tower") }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "HostUnavailable", hostId: "tower" });
    }).pipe(Effect.provide(Local)),
  );

  it.effect("finds a paired host by its id", () =>
    Effect.gen(function* () {
      const local = (yield* WorkerHosts).local;
      const tower: WorkerHost = { ...local, id: HostId.make("tower") };
      const hosts = WorkerHosts.fromHosts(local, [tower]);
      expect(yield* hosts.of({ hostId: tower.id })).toBe(tower);
      expect(yield* hosts.get(LOCAL_HOST_ID)).toBe(local);
    }).pipe(Effect.provide(Local)),
  );

  it.effect("the local host holds this machine's worktrees, git state and terminals", () =>
    Effect.gen(function* () {
      const { local } = yield* WorkerHosts;
      expect(local.worktrees).toBe(worktrees);
      expect(local.git).toBe(gitState);
      expect(local.terminals).toBe(terminals);
      expect(typeof local.files.list).toBe("function");
      expect(typeof local.ports.scan).toBe("object");
      expect(local.process).toBeUndefined();
    }).pipe(Effect.provide(WorkerHosts.layerLocal.pipe(Layer.provide(Machine)))),
  );

  it.effect("a test's host takes the parts its layer provides", () =>
    Effect.gen(function* () {
      const { local } = yield* WorkerHosts;
      expect(local.worktrees).toBe(worktrees);
      expect(local.git).toBe(gitState);
    }).pipe(Effect.provide(WorkerHosts.layerLocalForTests.pipe(Layer.provide(Machine)))),
  );

  it.effect("a part a test's host leaves out dies with its name when reached", () =>
    Effect.gen(function* () {
      const { local } = yield* WorkerHosts;
      const exit = yield* Effect.exit(local.worktrees.list("/repo", { openCheckouts: [] }));
      expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("no worktrees");
      const scan = yield* Effect.exit(local.ports.scan);
      expect(Exit.isFailure(scan)).toBe(true);
    }).pipe(Effect.provide(Local)),
  );

  it.live(
    "with the host process, this machine's folders are read through it",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "gram-worker-host-"));
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
        writeFileSync(join(dir, "through-the-host.txt"), "x\n");
        const { local } = yield* WorkerHosts;
        const listing = yield* local.files.list(dir, { showHidden: false, limit: 10 });
        expect(listing.entries.map((entry) => entry.name)).toEqual(["through-the-host.txt"]);
        expect(local.process?.pid).toBeGreaterThan(0);
        expect(local.process?.pid).not.toBe(process.pid);
        expect(local.worktrees).toBe(worktrees);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          WorkerHosts.layerLocalWith({ hostProcess: true }).pipe(Layer.provide(Machine)),
        ),
      ),
    30_000,
  );
});
