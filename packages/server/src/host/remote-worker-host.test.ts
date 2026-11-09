import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { describe, expect, it } from "@effect/vitest";
import type { AgentHost } from "@gram/agents";
import {
  HOST_PROTOCOL_VERSION,
  HostId,
  HostUnavailable,
  LOCAL_HOST_ID,
  type Thread,
  ThreadId,
} from "@gram/contracts";
import { Proc, ProcLive, Worktrees, WorktreesLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { EventHub } from "../events/event-hub.ts";
import { makeRepo, removeDir, tempDir, write } from "../git/test-repo.ts";
import type { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { cloneWorktrees } from "./clone-worktrees.ts";
import { filesOn } from "./files.ts";
import { gitOn } from "./git.ts";
import { connectHost, HOST_CAPABILITIES, type HostConnection, serveHost } from "./protocol.ts";
import type { RemoteHostsShape } from "./remote-hosts.ts";
import { machineHosts, machineWorkerHost, type MachineDeps } from "./remote-worker-host.ts";
import { reposOn } from "./repos.ts";
import { noAgents, sessionsOnHost } from "./sessions.ts";
import { terminalsOnHost } from "./terminals.ts";
import { streamPair } from "./test-stream.ts";
import { WorkerHosts } from "./worker-host.ts";

const MACHINE = { id: HostId.make("m-0123456789abcdef01234567"), name: "build box" };
const URL = "https://git.example.test/acme/widgets.git";

/** A project here with `URL` as its origin, which the machine reaches as a bare repository. */
const project = (dir: string) => {
  const root = makeRepo(join(dir, "here"));
  execFileSync("git", ["-C", root, "remote", "add", "origin", URL]);
  const bare = join(dir, "widgets.git");
  execFileSync("git", ["clone", "--quiet", "--bare", root, bare]);
  return {
    root,
    env: {
      GIT_ALLOW_PROTOCOL: "https:ssh:file",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.file://${bare}.insteadOf`,
      GIT_CONFIG_VALUE_0: URL,
    },
  };
};

/** The machine's host on one end of a stream, cloning into `repos`, and the connection to it. */
const machine = (repos: string, env: Record<string, string>) =>
  Effect.gen(function* () {
    const { host, control } = yield* streamPair;
    const proc = yield* Proc;
    const serving = yield* Effect.forkScoped(
      Effect.gen(function* () {
        yield* serveHost(yield* NodeSocket.fromDuplex(Effect.succeed(host)), {
          hello: {
            protocol: HOST_PROTOCOL_VERSION,
            hostId: MACHINE.id,
            capabilities: HOST_CAPABILITIES,
            platform: "linux",
            pid: 7,
          },
          files: filesOn(proc),
          repos: reposOn(proc, repos, env),
          worktrees: cloneWorktrees(proc, yield* Worktrees, env),
          git: gitOn(proc),
          terminals: yield* terminalsOnHost,
          sessions: yield* sessionsOnHost(noAgents),
          scan: Effect.succeed({ listening: new Map(), children: new Map() }),
        });
      }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => host.destroy()))),
    );
    const connection = yield* connectHost(yield* NodeSocket.fromDuplex(Effect.succeed(control)), {
      hostId: MACHINE.id,
    });
    return { connection, stop: Fiber.interrupt(serving) };
  });

/** The services a machine's host is built on, with no threads and nothing closing. */
const deps = (threads: ReadonlyArray<Thread> = []): Effect.Effect<MachineDeps, never, Proc> =>
  Effect.gen(function* () {
    const server = { kind: "claude" } as unknown as AgentHost;
    return {
      store: {
        listThreads: Effect.succeed(threads),
        getThread: () => Effect.die(new Error("no thread in this test")),
      } as unknown as ThreadStore["Service"],
      hub: { internalEvents: () => Stream.never } as unknown as EventHub["Service"],
      agents: AgentHosts.of({ get: () => Effect.succeed(server) }),
      proc: yield* Proc,
    };
  });

const thread = (checkout: Thread["checkout"]) =>
  ({ id: ThreadId.make("t-on-machine"), checkout }) as unknown as Thread;

const waitGone = (connection: HostConnection) =>
  Effect.gen(function* () {
    while (!connection.gone()) yield* Effect.sleep("20 millis");
  }).pipe(Effect.timeout("10 seconds"));

const Live = WorktreesLive.pipe(Layer.provideMerge(ProcLive));

describe("a joined machine's worker host", () => {
  it.live(
    "makes a worker's worktree from its own clone, keeps it on that machine, and refuses to lose work",
    () =>
      Effect.gen(function* () {
        const dir = tempDir();
        yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
        const { root, env } = project(dir);
        const repos = join(dir, "repos");
        const { connection } = yield* machine(repos, env);
        const host = yield* machineWorkerHost(MACHINE, connection, yield* deps());
        expect(host.id).toBe(MACHINE.id);

        const checkout = yield* host.checkouts.prepare(
          { kind: "newWorktree", branch: "feature/remote" },
          [],
          root,
        );
        const clone = join(repos, "git.example.test", "acme", "widgets");
        expect(checkout).toMatchObject({
          kind: "worktree",
          branch: "feature/remote",
          hostId: MACHINE.id,
          repoRoot: clone,
        });
        expect(checkout.path.startsWith(clone)).toBe(true);
        expect(existsSync(join(checkout.path, "tracked.txt"))).toBe(true);
        expect(yield* host.checkouts.present(checkout.path)).toBe(true);
        expect((yield* host.git.local(checkout.path)).branch).toBe("feature/remote");

        // Only a new worktree there: the project's own folder is on this machine.
        const current = yield* host.checkouts
          .prepare({ kind: "current" }, [], root)
          .pipe(Effect.flip);
        expect(current).toMatchObject({ _tag: "InvalidState" });

        // A token in the project's remote never crosses to the machine.
        execFileSync("git", [
          "-C",
          root,
          "remote",
          "set-url",
          "origin",
          "https://u:t@git.example.test/acme/widgets.git",
        ]);
        const tokened = yield* host.checkouts
          .prepare({ kind: "newWorktree", branch: "feature/other" }, [], root)
          .pipe(Effect.flip);
        expect(tokened).toMatchObject({ _tag: "InvalidState" });

        write(join(checkout.path, "wip.txt"), "uncommitted\n");
        const worker = thread(checkout);
        const dirty = yield* host.checkouts
          .release(worker, { removeWorktree: { force: false } })
          .pipe(Effect.flip);
        expect(dirty).toMatchObject({
          _tag: "WorktreeDirty",
          path: checkout.path,
          changedFiles: 1,
        });
        expect(existsSync(checkout.path)).toBe(true);
        yield* host.checkouts.release(worker, { removeWorktree: { force: true } });
        expect(existsSync(checkout.path)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(Live)),
    30_000,
  );

  it.live("refuses an explicit base available only on the main machine", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const { root, env } = project(dir);
      execFileSync("git", ["-C", root, "branch", "feat/local-only"]);
      const repos = join(dir, "repos");
      const { connection } = yield* machine(repos, env);
      const host = yield* machineWorkerHost(MACHINE, connection, yield* deps());
      const result = yield* host.checkouts
        .prepare(
          { kind: "newWorktree", branch: "feat/dependent", base: "feat/local-only" },
          [],
          root,
        )
        .pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "InvalidState",
          message: expect.stringContaining("feat/local-only"),
        },
      });
      const clone = join(repos, "git.example.test", "acme", "widgets");
      expect(existsSync(join(clone, ".worktrees"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(Live)),
  );

  it.live(
    "fetches an explicit remote base even with a narrowed clone refspec and returns the chosen ref",
    () =>
      Effect.gen(function* () {
        const dir = tempDir();
        yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
        const { root, env } = project(dir);
        const repos = join(dir, "repos");
        const { connection } = yield* machine(repos, env);
        const host = yield* machineWorkerHost(MACHINE, connection, yield* deps());
        yield* host.checkouts.prepare({ kind: "newWorktree", branch: "feat/first" }, [], root);
        const clone = join(repos, "git.example.test", "acme", "widgets");
        execFileSync("git", [
          "-C",
          clone,
          "config",
          "remote.origin.fetch",
          "+refs/heads/main:refs/remotes/origin/main",
        ]);
        execFileSync("git", ["-C", root, "checkout", "-b", "feat/prerequisite"]);
        execFileSync("git", [
          "-C",
          root,
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          "prerequisite",
        ]);
        execFileSync("git", ["-C", root, "push", "--quiet", join(dir, "widgets.git"), "HEAD"]);
        const expected = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim();
        for (const [index, base] of ["feat/prerequisite", "origin/feat/prerequisite"].entries()) {
          const checkout = yield* host.checkouts.prepare(
            { kind: "newWorktree", branch: `feat/dependent-${index}`, base },
            [],
            root,
          );
          expect(checkout.base).toBe("origin/feat/prerequisite");
          expect(
            execFileSync("git", ["-C", checkout.path, "rev-parse", "HEAD"], {
              encoding: "utf8",
            }).trim(),
          ).toBe(expected);
        }
      }).pipe(Effect.scoped, Effect.provide(Live)),
  );

  it.live("starts nothing here while the machine is offline", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const { connection, stop } = yield* machine(join(dir, "repos"), {});
      const host = yield* machineWorkerHost(MACHINE, connection, yield* deps());
      yield* stop;
      yield* waitGone(connection);
      const agent = yield* host.sessions.get("claude");
      const refused = yield* agent
        .open({ threadId: ThreadId.make("t-on-machine"), cwd: "/srv/work" } as never)
        .pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "AgentUnavailable",
        message: expect.stringContaining("build box is offline"),
      });
      const terminal = yield* host.terminals
        .open({ threadId: ThreadId.make("t-on-machine"), cols: 80, rows: 24 })
        .pipe(Effect.flip);
      expect(terminal).toMatchObject({ _tag: "InvalidState" });
      expect(yield* host.terminals.list()).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(Live)),
  );

  it.live("is built once per connection and reached through WorkerHosts by its id", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      let current: HostConnection | undefined = (yield* machine(join(dir, "repos"), {})).connection;
      const remote = {
        connection: (id: HostId) =>
          id === MACHINE.id && current !== undefined
            ? Effect.succeed(current)
            : Effect.fail(new HostUnavailable({ hostId: id, message: "not dialled in" })),
        machines: { get: () => ({ name: MACHINE.name }) },
      } as unknown as RemoteHostsShape;
      const get = yield* machineHosts(remote, yield* deps());
      const local = { id: LOCAL_HOST_ID } as never;
      const hosts = WorkerHosts.fromHosts(local, [], get);
      const first = yield* hosts.get(MACHINE.id);
      expect(first.id).toBe(MACHINE.id);
      expect(yield* hosts.of({ hostId: MACHINE.id })).toBe(first);
      expect(yield* hosts.of({})).toBe(local);
      // Dialled in again: a new host for the new connection.
      current = (yield* machine(join(dir, "repos-2"), {})).connection;
      const second = yield* hosts.get(MACHINE.id);
      expect(second).not.toBe(first);
      current = undefined;
      expect((yield* hosts.get(MACHINE.id).pipe(Effect.flip))._tag).toBe("HostUnavailable");
    }).pipe(Effect.scoped, Effect.provide(Live)),
  );
});
