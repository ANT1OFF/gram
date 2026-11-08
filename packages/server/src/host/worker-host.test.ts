import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostId, LOCAL_HOST_ID } from "@gram/contracts";
import { describe, expect, it } from "@effect/vitest";
import type { GitState } from "@gram/contracts";
import { GitStateRuntime, ProcLive, Worktrees } from "@gram/git";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { CheckoutService } from "../runtime/hooks.ts";
import { HostTerminals } from "../terminal/host-terminals.ts";
import type { Terminals } from "../terminal/terminals.ts";
import { makeRepo, removeDir, tempDir } from "../git/test-repo.ts";
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

const SERVER_LIST = { repoTop: "/in-server", worktrees: [] };
const SERVER_STATE = { repo: false } as unknown as GitState;
/** The server's own worktrees and git state, telling a read the server did from one the host did. */
const InServer = Layer.mergeAll(
  Agents,
  Layer.succeed(Worktrees, {
    ...worktrees,
    list: () => Effect.succeed(SERVER_LIST),
  } as Worktrees["Service"]),
  Layer.succeed(GitStateRuntime, {
    local: () => Effect.succeed(SERVER_STATE),
    present: () => Effect.succeed(true),
    // The network tier stays here, built on the local read it was given.
    snapshot: (_cwd, options) =>
      Effect.succeed({ ...(options.local ?? SERVER_STATE), origin: "acme/widgets" }),
    watch: (paths) =>
      Stream.fromIterable(
        paths.map((path) => ({ path, seq: 1, live: false, state: SERVER_STATE })),
      ),
  } as GitStateRuntime["Service"]),
  Layer.succeed(HostTerminals, terminals),
  ProcLive,
);
const ThroughHost = WorkerHosts.layerLocalWith({ hostProcess: true }).pipe(Layer.provide(InServer));

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
    "with the host process, this machine's folders, worktrees and git state go through it",
    () =>
      Effect.gen(function* () {
        const tmp = tempDir();
        yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(tmp)));
        const repo = makeRepo(tmp);
        writeFileSync(join(repo, "through-the-host.txt"), "x\n");
        const { local } = yield* WorkerHosts;
        expect(local.process?.pid).toBeGreaterThan(0);
        expect(local.process?.pid).not.toBe(process.pid);
        const listing = yield* local.files.list(repo, { showHidden: false, limit: 10 });
        expect(listing.entries.map((entry) => entry.name)).toContain("through-the-host.txt");
        const worktreeList = yield* local.worktrees.list(repo, { openCheckouts: [] });
        expect(worktreeList.worktrees).toMatchObject([{ isMain: true, branch: "main" }]);
        // A list that needs the server's activity lookup stays in the server.
        const withActivity = yield* local.worktrees.list(repo, {
          openCheckouts: [],
          lastActivity: () => 0,
        });
        expect(withActivity).toBe(SERVER_LIST);
        expect(yield* local.git.local(repo)).toMatchObject({ repo: true, changedFiles: 1 });
        const snapshot = yield* local.git.snapshot(repo, { remote: true });
        expect(snapshot).toMatchObject({ repo: true, branch: "main", origin: "acme/widgets" });
      }).pipe(Effect.scoped, Effect.provide(ThroughHost)),
    30_000,
  );

  it.live(
    "a snapshot that reuses the local read builds on what the host's watcher last saw",
    () =>
      Effect.gen(function* () {
        const tmp = tempDir();
        yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(tmp)));
        const repo = makeRepo(tmp);
        const { local } = yield* WorkerHosts;
        const [seen] = yield* local.git
          .watch([repo], { debounceMs: 50, cooldownMs: 100 })
          .pipe(Stream.take(1), Stream.runCollect, Effect.timeout("20 seconds"));
        expect(seen?.state).toMatchObject({ repo: true, changedFiles: 0 });
        // Changed after the watch stopped, so only a fresh read sees it.
        writeFileSync(join(repo, "after-the-watch.txt"), "x\n");
        const reused = yield* local.git.snapshot(repo, { remote: false, reuseLocal: true });
        expect(reused).toMatchObject({ changedFiles: 0, origin: "acme/widgets" });
        const fresh = yield* local.git.snapshot(repo, { remote: false });
        expect(fresh).toMatchObject({ changedFiles: 1, origin: "acme/widgets" });
      }).pipe(Effect.scoped, Effect.provide(ThroughHost)),
    30_000,
  );

  it.live(
    "a host process that stops hands this machine's work back to the server",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "gram-worker-host-"));
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
        writeFileSync(join(dir, "still-here.txt"), "x\n");
        const { local } = yield* WorkerHosts;
        process.kill(local.process!.pid, "SIGKILL");
        yield* Effect.sleep("300 millis");
        const listing = yield* local.files.list(dir, { showHidden: false, limit: 10 });
        expect(listing.entries.map((entry) => entry.name)).toEqual(["still-here.txt"]);
        expect(yield* local.worktrees.list(dir, { openCheckouts: [] })).toBe(SERVER_LIST);
        expect(yield* local.git.local(dir)).toBe(SERVER_STATE);
        const changes = yield* Stream.runCollect(local.git.watch([dir]));
        expect(changes).toEqual([{ path: dir, seq: 1, live: false, state: SERVER_STATE }]);
      }).pipe(Effect.scoped, Effect.provide(ThroughHost)),
    30_000,
  );

  it.live(
    "a watch the host process was serving restarts in the server when it stops",
    () =>
      Effect.gen(function* () {
        const tmp = tempDir();
        yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(tmp)));
        const repo = makeRepo(tmp);
        const { local } = yield* WorkerHosts;
        const seen: Array<GitState> = [];
        const watching = local.git.watch([repo], { debounceMs: 50, cooldownMs: 100 }).pipe(
          Stream.tap((change) =>
            Effect.sync(() => {
              seen.push(change.state);
              if (seen.length === 1) process.kill(local.process!.pid, "SIGKILL");
            }),
          ),
          Stream.runDrain,
        );
        yield* watching.pipe(Effect.timeout("20 seconds"));
        expect(seen[0]).toMatchObject({ repo: true, branch: "main" });
        expect(seen.at(-1)).toBe(SERVER_STATE);
      }).pipe(Effect.scoped, Effect.provide(ThroughHost)),
    30_000,
  );
});
