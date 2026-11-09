import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
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
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { makeRepo, removeDir, tempDir, write } from "../git/test-repo.ts";
import { EventHub as EventHubTag } from "../events/event-hub.ts";
import { ThreadStore as ThreadStoreTag } from "../persistence/thread-store.ts";
import { ProcessRoots, type PortScan, ThreadPorts } from "../ports/service.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { closeAtRest } from "../runtime/close-at-rest.ts";
import { ThreadRuntimes, type ThreadRuntimesShape } from "../runtime/thread-runtimes.ts";
import { attachmentsOnHost, fileReadsOn } from "./file-reads.ts";
import { cloneWorktrees } from "./clone-worktrees.ts";
import { filesOn } from "./files.ts";
import { gitOn } from "./git.ts";
import {
  connectHost,
  HOST_CAPABILITIES,
  type HostConnection,
  type HostWorktrees,
  serveHost,
} from "./protocol.ts";
import type { RemoteHostsShape } from "./remote-hosts.ts";
import { machineHosts, machineWorkerHost, type MachineDeps } from "./remote-worker-host.ts";
import { cloneFolderOf, cloneIdentityOf, reposOn } from "./repos.ts";
import { noAgents, sessionsOnHost } from "./sessions.ts";
import { type HostTerminalsService, terminalsOnHost } from "./terminals.ts";
import { streamPair } from "./test-stream.ts";
import { type WorkerHost, WorkerHosts } from "./worker-host.ts";

const MACHINE = { id: HostId.make("m-0123456789abcdef01234567"), name: "build box" };
const URL = "https://git.example.test/acme/widgets.git";
const cloneAt = (repos: string) => {
  const target = cloneFolderOf(URL);
  if ("error" in target) throw new Error(target.error);
  return join(repos, target.folder);
};

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
const machine = (
  repos: string,
  env: Record<string, string>,
  /** The machine's own port scan; none of its processes by default. */
  scan: Effect.Effect<PortScan> = Effect.succeed({ listening: new Map(), children: new Map() }),
  /** Called with the machine's terminals once its host serves them. */
  onTerminals?: (terminals: HostTerminalsService) => void,
  /** The machine's worktree code as its host runs it: a test's host can answer otherwise. */
  worktreesThere: (honest: HostWorktrees) => HostWorktrees = (honest) => honest,
) =>
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
          reads: fileReadsOn(proc),
          attachments: yield* attachmentsOnHost(mkdtempSync(join(tmpdir(), "gram-host-attached-"))),
          repos: reposOn(proc, repos, env),
          worktrees: worktreesThere(cloneWorktrees(proc, yield* Worktrees, env)),
          git: gitOn(proc),
          terminals: yield* terminalsOnHost.pipe(
            Effect.tap((t) => Effect.sync(() => onTerminals?.(t))),
          ),
          sessions: yield* sessionsOnHost(noAgents),
          scan,
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
      } as unknown as ThreadStoreTag["Service"],
      hub: { internalEvents: () => Stream.never } as unknown as EventHubTag["Service"],
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
  // What a check of the worker's ownership later goes by is this machine's record, never the
  // host's reply: a host that lies about the worktree it made can't choose what is recorded.
  for (const lie of ["another branch", "other records"] as const) {
    it.live(`records only its own values for a worktree made there, given ${lie}`, () =>
      Effect.gen(function* () {
        const dir = tempDir();
        yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
        const { root, env } = project(dir);
        const repos = join(dir, "repos");
        const { connection } = yield* machine(repos, env, undefined, undefined, (honest) => ({
          ...honest,
          create: (request) =>
            honest.create(request).pipe(
              Effect.map((created) => ({
                ...created,
                checkout:
                  lie === "another branch"
                    ? { ...created.checkout, branch: "feat/by-another-thread" }
                    : {
                        ...created.checkout,
                        repoRoot: "/home/invented/elsewhere",
                        hostId: HostId.make("m-ffffffffffffffffffffffff"),
                        cloneIdentity: cloneIdentityOf("https://git.example.test/other/repo.git")!,
                      },
              })),
            ),
        }));
        const host = yield* machineWorkerHost(MACHINE, connection, yield* deps());
        const prepared = host.checkouts.prepare(
          { kind: "newWorktree", branch: "feat/review-ownership" },
          [],
          root,
        );
        if (lie === "another branch") {
          expect((yield* prepared.pipe(Effect.flip)).message).toBe(
            "build box made the worktree on another branch than the feat/review-ownership Gram asked for, so it isn't used.",
          );
          return;
        }
        const checkout = yield* prepared;
        // Kept from its reply: where it put the worktree, and the base it chose, set aside here.
        const { base: _base, ...recorded } = checkout;
        expect(recorded).toEqual({
          kind: "worktree",
          path: checkout.path,
          hostId: MACHINE.id,
          branch: "feat/review-ownership",
          repoRoot: cloneAt(repos),
          cloneIdentity: cloneIdentityOf(URL),
        });
      }).pipe(Effect.scoped, Effect.provide(Live)),
    );
  }

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
        const clone = cloneAt(repos);
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
      const clone = cloneAt(repos);
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
        const clone = cloneAt(repos);
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

  it.live("uses the fresh origin base when the clone's local default branch is behind", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const { root, env } = project(dir);
      const { connection } = yield* machine(join(dir, "repos"), env);
      const host = yield* machineWorkerHost(MACHINE, connection, yield* deps());
      yield* host.checkouts.prepare({ kind: "newWorktree", branch: "feat/first" }, [], root);
      execFileSync("git", ["-C", root, "commit", "--quiet", "--allow-empty", "-m", "new main"]);
      execFileSync("git", ["-C", root, "push", "--quiet", join(dir, "widgets.git"), "HEAD"]);
      const expected = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const checkout = yield* host.checkouts.prepare(
        { kind: "newWorktree", branch: "feat/new-main", base: "main" },
        [],
        root,
      );
      expect(checkout.base).toBe("origin/main");
      expect(
        execFileSync("git", ["-C", checkout.path, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
      ).toBe(expected);
    }).pipe(Effect.scoped, Effect.provide(Live)),
  );

  it.live("keeps an explicitly selected host branch's additional work", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      const { root, env } = project(dir);
      execFileSync("git", [
        "-C",
        root,
        "push",
        "--quiet",
        join(dir, "widgets.git"),
        "HEAD:refs/heads/feat/shared",
      ]);
      const repos = join(dir, "repos");
      const { connection } = yield* machine(repos, env);
      const host = yield* machineWorkerHost(MACHINE, connection, yield* deps());
      yield* host.checkouts.prepare({ kind: "newWorktree", branch: "feat/first" }, [], root);
      const clone = cloneAt(repos);
      execFileSync("git", [
        "-C",
        clone,
        "checkout",
        "-q",
        "-b",
        "feat/shared",
        "origin/feat/shared",
      ]);
      execFileSync("git", [
        "-C",
        clone,
        "-c",
        "user.name=Synthetic",
        "-c",
        "user.email=synthetic@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "host work",
      ]);
      const expected = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const checkout = yield* host.checkouts.prepare(
        { kind: "newWorktree", branch: "feat/dependent", base: "feat/shared" },
        [],
        root,
      );
      expect(checkout.base).toBe("feat/shared");
      expect(
        execFileSync("git", ["-C", checkout.path, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
      ).toBe(expected);
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

/**
 * A close at rest of a thread on the machine, through the server's `ThreadPorts`, with this
 * machine running nothing in any terminal: what it closed, or why it refused.
 */
const closeOnMachine = (get: (id: HostId) => Effect.Effect<WorkerHost, HostUnavailable>) =>
  Effect.gen(function* () {
    const worker = thread({
      kind: "local",
      path: "/srv/synthetic/work",
      hostId: MACHINE.id,
    } as never);
    const closed: Array<ThreadId> = [];
    const runtimes = {
      processIds: Effect.succeed([]),
      close: (threadId: ThreadId) => Effect.sync(() => void closed.push(threadId)),
      releaseAfterClose: (_: ThreadId, release: Effect.Effect<void>) => release,
    } as unknown as ThreadRuntimesShape;
    const local = {
      id: LOCAL_HOST_ID,
      // This machine's scan would find nothing of the other machine's shells.
      ports: { scan: Effect.succeed({ listening: new Map(), children: new Map() }) },
    } as unknown as WorkerHost;
    const ports = yield* Effect.provide(
      ThreadPorts,
      ThreadPorts.layer.pipe(
        Layer.provide(ProcessRoots.layer),
        Layer.provide(Layer.succeed(ThreadRuntimes)(runtimes)),
        Layer.provide(
          Layer.succeed(EventHubTag)({
            publish: () => Effect.void,
          } as unknown as EventHubTag["Service"]),
        ),
        Layer.provide(
          Layer.succeed(ThreadStoreTag)({
            getThread: () => Effect.succeed(worker),
          } as unknown as ThreadStoreTag["Service"]),
        ),
        Layer.provide(Layer.succeed(WorkerHosts)(WorkerHosts.fromHosts(local, [], get))),
      ),
    );
    const result = yield* closeAtRest(runtimes, ports, undefined, worker.id).pipe(
      Effect.flip,
      Effect.option,
    );
    return { closed, refused: Option.getOrUndefined(result) };
  });

describe("a joined machine's terminals at rest", () => {
  it.live("are read on that machine, so a command running there keeps the thread open", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
      /** The machine's shell's pid there, and whether a command runs in its foreground. */
      let shell: number | undefined;
      let running = false;
      const scan = Effect.sync((): PortScan => {
        if (shell === undefined) return { listening: new Map(), children: new Map() };
        const job = shell + 1_000_000;
        const tpgid = running ? job : shell;
        return {
          listening: new Map(),
          children: new Map([[shell, running ? [job] : []]]),
          processes: new Map([
            [shell, { pid: shell, ppid: 1, pgid: shell, tpgid, command: "-bash" }],
            ...(running
              ? [[job, { pid: job, ppid: shell, pgid: job, tpgid, command: "make build" }] as const]
              : []),
          ]),
        };
      });
      let onMachine: HostTerminalsService | undefined;
      const { connection } = yield* machine(join(dir, "repos"), {}, scan, (t) => {
        onMachine = t;
      });
      const worker = thread({ kind: "local", path: dir, hostId: MACHINE.id } as never);
      const host = yield* machineWorkerHost(MACHINE, connection, {
        ...(yield* deps([worker])),
        store: {
          listThreads: Effect.succeed([worker]),
          getThread: () => Effect.succeed(worker),
        } as unknown as ThreadStoreTag["Service"],
      });
      const get = (id: HostId) =>
        id === MACHINE.id
          ? Effect.succeed(host)
          : Effect.fail(new HostUnavailable({ hostId: id, message: "not paired" }));

      // No terminal at all: at rest.
      expect(yield* host.ports.terminalBusy!(worker.id)).toBe(false);

      const opened = yield* host.terminals.open({ threadId: worker.id, cols: 80, rows: 24 });
      const root = Option.getOrThrow(yield* Stream.runHead(onMachine!.roots));
      shell = root.kind === "add" ? root.pid : undefined;
      expect(shell).toBeTypeOf("number");
      // The shell's id reaches this side over the connection.
      for (let i = 0; i < 200 && (yield* host.ports.terminalBusy!(worker.id)) === undefined; i++)
        yield* Effect.sleep("20 millis");
      expect(yield* host.ports.terminalBusy!(worker.id)).toBe(false);

      running = true;
      expect(yield* host.ports.terminalBusy!(worker.id)).toBe(true);
      // Before, this machine's empty scan ruled the thread at rest, and the close went ahead.
      const busy = yield* closeOnMachine(get);
      expect(busy.closed).toEqual([]);
      expect(busy.refused).toMatchObject({
        _tag: "InvalidState",
        message: expect.stringContaining("running a command"),
      });

      running = false;
      const idle = yield* closeOnMachine(get);
      expect(idle.refused).toBeUndefined();
      expect(idle.closed).toEqual([worker.id]);
      yield* host.terminals.close(opened.terminalId);
    }).pipe(Effect.scoped, Effect.provide(Live)),
  );

  it.live("count as busy while the machine can't be asked", () =>
    Effect.gen(function* () {
      const { closed, refused } = yield* closeOnMachine((id) =>
        Effect.fail(new HostUnavailable({ hostId: id, message: "That machine is offline." })),
      );
      expect(closed).toEqual([]);
      expect(refused).toMatchObject({
        _tag: "InvalidState",
        message: expect.stringContaining("couldn't be read"),
      });
    }).pipe(Effect.provide(Live)),
  );
});
