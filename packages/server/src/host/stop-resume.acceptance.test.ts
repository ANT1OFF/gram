// Acceptance for stopping a machine with its disk kept and resuming on a host started on that
// disk: a thread works on a joined machine, the machine is readied and its host ends, another
// host starts on the same volume, and the thread goes on in the same conversation.
//
// Synthetic: the fake agent, real git against a bare remote on disk, and the host protocol over
// an in-process stream that this Gram attaches as it attaches a machine's dial.

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { describe, expect, it } from "@effect/vitest";
import {
  applySettingsPatch,
  HOST_PROTOCOL_VERSION,
  type HostBusy,
  HostId,
  type ThreadId,
  type ThreadStatus,
} from "@gram/contracts";
import { Proc, ProcLive, wipRef, Worktrees, WorktreesLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "../git/test-repo.ts";
import {
  HOST_STOP_PATHS,
  hostStopRoute,
  MACHINES_STOP_CANCEL_PATH,
  MACHINES_STOP_PREPARE_PATH,
  MACHINES_STOP_RESUME_PATH,
  MACHINES_STOP_STATUS_PATH,
} from "../http/host-stop-routes.ts";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { UsageLimitReadings } from "../usage/limit-readings.ts";
import { CheckoutService, TurnHooks } from "../runtime/hooks.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { HttpServerRequest, HttpServerResponse } from "../platform/unstable.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { FakeAgentAdapter, FakeAgentControl, type FakeSession } from "../runtime/fake-agent.ts";
import { machineRestartText } from "../runtime/machine-restart.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { makeAdmission } from "./admission.ts";
import { attachmentsOnHost, fileReadsOn } from "./file-reads.ts";
import { filesOn } from "./files.ts";
import { gitOn } from "./git.ts";
import { readHostConfig, writeJoined } from "./host-config.ts";
import { generateHostKey, hostIdOf } from "./machine-keys.ts";
import { memoryMachineStore } from "./paired-machines.ts";
import { HOST_FEATURES, HOST_SERVES, type HostService, serveHost } from "./protocol.ts";
import { RemoteHosts } from "./remote-hosts.ts";
import { reposOn } from "./repos.ts";
import { sessionsOnHost } from "./sessions.ts";
import { stopOn } from "./stop.ts";
import { terminalsOnHost } from "./terminals.ts";
import { streamPair } from "./test-stream.ts";
import { WorkerHosts } from "./worker-host.ts";

const ORIGIN = "https://gram.tailnet.ts.net";
const NAME = "sandbox";

/**
 * A machine's disk: the host's own folder (its join and key) and a thread's worktree, with the
 * repository's remote somewhere else. Hosts come and go; this stays.
 */
const makeVolume = () => {
  const dir = tempDir();
  const repo = makeRepo(dir);
  const origin = join(tmpdir(), `gram-stop-origin-${process.pid}-${Date.now()}.git`);
  run(dir, "init", "--bare", "--quiet", origin);
  run(repo, "remote", "add", "origin", origin);
  run(repo, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  const home = join(dir, "host");
  mkdirSync(home, { mode: 0o700 });
  return { dir, repo, origin, home };
};
type Volume = ReturnType<typeof makeVolume>;

/** Joins a machine to this Gram and writes its join to the volume, as `gram-host join` does. */
const joinMachine = (volume: Volume) =>
  Effect.gen(function* () {
    const hosts = yield* RemoteHosts;
    const key = generateHostKey();
    const code = new URLSearchParams(new URL(hosts.machines.mint(ORIGIN).url).hash.slice(1)).get(
      "code",
    )!;
    hosts.machines.join(ORIGIN, { code, name: NAME, platform: "linux", publicKey: key.publicKey });
    const id = hostIdOf(key.publicKey);
    hosts.machines.confirm(id);
    writeJoined(
      volume.home,
      { version: 1, origin: ORIGIN, hostId: id, name: NAME },
      key.privateKeyPem,
    );
    return id;
  });

let pids = 4000;

/**
 * A host process started on the volume: it is whoever the volume's join says, serves real git,
 * files and the stop calls, runs its sessions on the fake agent, and dials this Gram. `end` is the
 * machine taken away: the process and everything in it gone, the disk as it was.
 */
const startHost = (volume: Volume) =>
  Effect.gen(function* () {
    const remote = yield* RemoteHosts;
    const fake = yield* AgentHosts;
    const proc = yield* Proc;
    const worktrees = yield* Worktrees;
    const joined = readHostConfig(volume.home);
    if (joined === undefined) return yield* Effect.die(new Error("the volume holds no join"));
    const hostId = HostId.make(joined.hostId);
    const machine = remote.machines.get(hostId);
    if (machine === undefined) return yield* Effect.die(new Error("not joined here"));
    const pid = pids++;
    /** The threads of the sessions this host opened. */
    const opened: Array<string> = [];
    const scope = yield* Scope.make();
    const service = yield* Effect.gen(function* () {
      const sessions = yield* sessionsOnHost(
        (kind) =>
          Effect.map(fake.get(kind), (agent) => ({
            ...agent,
            open: (options) =>
              Effect.andThen(
                Effect.sync(() => void opened.push(options.threadId)),
                agent.open(options),
              ),
          })),
        () => Effect.die(new Error("no app tools in this test")),
      );
      const admission = makeAdmission();
      const busy = Effect.sync((): HostBusy => ({
        turns: sessions.busy(),
        terminals: 0,
        clones: 0,
        checks: 0,
      }));
      return {
        hello: {
          protocol: HOST_PROTOCOL_VERSION,
          hostId,
          capabilities: HOST_SERVES,
          features: HOST_FEATURES,
          platform: "linux",
          pid,
        },
        files: filesOn(proc),
        reads: fileReadsOn(proc),
        attachments: yield* attachmentsOnHost(mkdtempSync(join(tmpdir(), "gram-stop-attached-"))),
        repos: reposOn(proc, join(volume.home, "repos")),
        worktrees,
        git: gitOn(proc),
        terminals: yield* terminalsOnHost,
        sessions,
        scan: Effect.succeed({ listening: new Map(), children: new Map() }),
        admission,
        // The test's remote is a bare repository on disk.
        stop: stopOn({ proc, busy, admission, protocols: "file" }),
      } satisfies HostService;
    }).pipe(Scope.provide(scope));
    const { host: hostEnd, control } = yield* streamPair.pipe(Scope.provide(scope));
    const serving = yield* Effect.forkIn(
      Effect.flatMap(NodeSocket.fromDuplex(Effect.succeed(hostEnd)), (socket) =>
        serveHost(socket, service),
      ),
      scope,
    );
    // This Gram's side, as its `/host/connect` route takes a dial.
    const socket = yield* NodeSocket.fromDuplex(Effect.succeed(control));
    yield* Effect.forkIn(remote.attach(remote.admit(machine, ORIGIN), socket), scope);
    yield* eventually(
      "the host online",
      remote.connection(hostId).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ),
    );
    return {
      hostId,
      pid,
      opened,
      /** The turns the host itself counts as under way. */
      turns: () => service.sessions.busy(),
      end: Effect.gen(function* () {
        yield* Fiber.interrupt(serving);
        hostEnd.destroy();
        control.destroy();
        yield* Scope.close(scope, Exit.void);
        yield* eventually(
          "the host offline",
          remote.connection(hostId).pipe(
            Effect.as(false),
            Effect.orElseSucceed(() => true),
          ),
        );
      }),
    };
  });

const eventually = <A, E, R>(label: string, check: Effect.Effect<A | undefined | false, E, R>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 500; i++) {
      const value = yield* check;
      if (value !== undefined && value !== false) return value;
      yield* Effect.sleep("20 millis");
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

/** The thread's sessions as the fake agent opened them on a host, once there are `count`. */
const nthSession = (threadId: ThreadId, count: number) =>
  Effect.gen(function* () {
    const fake = yield* FakeAgentControl;
    return yield* eventually(
      `session ${count}`,
      Effect.sync((): FakeSession | undefined => {
        const mine = fake.sessions.filter((s) => s.options.threadId === threadId);
        return mine.length >= count ? mine[count - 1] : undefined;
      }),
    );
  });

const statusIs = (threadId: ThreadId, status: ThreadStatus) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    return yield* eventually(
      status,
      runtimes.status(threadId).pipe(Effect.map((now) => now === status)),
    );
  });

/** One POST to a stop route from the local app, answered as the server answers it. */
const post = (path: string, body: unknown) =>
  Effect.gen(function* () {
    expect(HOST_STOP_PATHS.has(path)).toBe(true);
    const store = yield* ThreadStore;
    const response = yield* hostStopRoute(
      {
        hosts: yield* RemoteHosts,
        store,
        runtimes: yield* ThreadRuntimes,
        settings: store,
      },
      path,
    ).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request(`http://127.0.0.1${path}`, {
            method: "POST",
            headers: {
              origin: "http://127.0.0.1",
              "content-type": "application/json",
              "content-length": String(Buffer.byteLength(JSON.stringify(body))),
            },
            body: JSON.stringify(body),
          }),
        ),
      ),
      Effect.map((answer) => HttpServerResponse.toWeb(answer)),
    );
    const answer = (yield* Effect.promise(() => response.json())) as {
      readonly machines?: ReadonlyArray<{ readonly wanted?: boolean }>;
    };
    return { status: response.status, body: answer };
  });

const hostedFeatures = (on: boolean) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    yield* store.updateSettings(
      (settings) => applySettingsPatch(settings, { experimental: { embedding: on } }),
      [["experimental", "embedding"]],
    );
  });

/**
 * The runtime with joined machines: a thread placed on one opens its sessions on that machine's
 * host, as in the server. The app tools are left out, since this runtime has no MCP endpoint for
 * a machine to reach them at.
 */
const testLayer = () => {
  const hosts = Layer.effect(
    WorkerHosts,
    Effect.gen(function* () {
      const base = yield* WorkerHosts;
      return WorkerHosts.of({
        ...base,
        placed: {
          ...base.placed,
          sessions: AgentHosts.of({
            get: (kind) =>
              Effect.map(base.placed.sessions.get(kind), (agent) => ({
                ...agent,
                open: (options) => {
                  const { appTools: _, ...rest } = options;
                  return agent.open(rest);
                },
              })),
          }),
        },
      });
    }),
  ).pipe(Layer.provide(WorkerHosts.layerLocalForTests));
  // As `makeRuntimeTestLayer` builds the core services, with the joined machines under them.
  return AppToolRegistry.layer.pipe(
    Layer.provideMerge(ThreadRuntimes.layer),
    Layer.provideMerge(hosts),
    Layer.provideMerge(Layer.effect(RemoteHosts, RemoteHosts.make(memoryMachineStore()))),
    Layer.provideMerge(UsageLimitReadings.layer),
    Layer.provideMerge(EventHub.layer),
    Layer.provideMerge(ThreadStore.layerSqlite(":memory:")),
    Layer.provideMerge(FakeAgentAdapter),
    Layer.provideMerge(TurnHooks.layerNoop),
    Layer.provideMerge(CheckoutService.layerNoGit),
    Layer.provideMerge(ServerConfig.layer(TEST_CONFIG)),
    Layer.provideMerge(WorktreesLive.pipe(Layer.provideMerge(ProcLive))),
    Layer.orDie,
  );
};

/** A worker on the machine whose first turn ended with files changed and nothing committed. */
const workedThread = (volume: Volume, hostId: HostId) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const thread = yield* runtimes.create({
      projectRoot: volume.repo,
      checkout: { kind: "worktree", path: volume.repo, branch: "main", hostId },
      input: { text: "build the feature" },
    } as never);
    const first = yield* nthSession(thread.id, 1);
    yield* eventually(
      "the first send",
      Effect.sync(() => first.sent.length === 1),
    );
    write(join(volume.repo, "tracked.txt"), "half done\n");
    write(join(volume.repo, "feature.ts"), "export const feature = 1;\n");
    yield* first.completeTurn("half way there");
    yield* statusIs(thread.id, "idle");
    const store = yield* ThreadStore;
    const sessionId = yield* eventually(
      "the conversation's id",
      store.getThread(thread.id).pipe(Effect.map((t) => t.agentSessionId)),
    );
    return { thread, first, sessionId };
  });

describe.skipIf(!hasGit)("stopping a machine and resuming on a new host", () => {
  it.live(
    "stop, start a different host with the same volume, and the thread continues",
    () =>
      Effect.gen(function* () {
        const volume = makeVolume();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            removeDir(volume.dir);
            removeDir(volume.origin);
          }),
        );
        yield* hostedFeatures(true);
        const hostId = yield* joinMachine(volume);
        const hostA = yield* startHost(volume);
        const { thread, first, sessionId } = yield* workedThread(volume, hostId);
        const head = run(volume.repo, "rev-parse", "HEAD").trim();

        // Ready it to stop: idle, its work in progress on the remote, its session at rest.
        const prepared = yield* post(MACHINES_STOP_PREPARE_PATH, { id: hostId });
        expect(prepared.status).toBe(200);
        expect(prepared.body).toMatchObject({
          idle: true,
          working: [],
          kept: [{ threadId: thread.id, cwd: volume.repo, ref: wipRef(thread.id), pushed: true }],
        });
        expect(run(volume.origin, "show", `${wipRef(thread.id)}:feature.ts`)).toBe(
          "export const feature = 1;\n",
        );
        expect(run(volume.origin, "show", `${wipRef(thread.id)}:tracked.txt`)).toBe("half done\n");
        expect(run(volume.repo, "rev-parse", "HEAD").trim()).toBe(head);
        yield* statusIs(thread.id, "cold");
        yield* eventually(
          "the session closed on the host",
          Effect.sync(() => first.closed),
        );

        // The machine is taken away. Its disk stays.
        yield* hostA.end;
        expect((yield* post(MACHINES_STOP_STATUS_PATH, {})).body).toEqual({
          machines: [
            {
              id: hostId,
              name: NAME,
              online: false,
              stoppedAt: expect.any(Number),
              wanted: false,
            },
          ],
        });

        // A different host starts on the same volume, and is the same machine to this Gram.
        const hostB = yield* startHost(volume);
        expect(hostB.pid).not.toBe(hostA.pid);
        expect(hostB.hostId).toBe(hostId);
        const resumed = yield* post(MACHINES_STOP_RESUME_PATH, { id: hostId });
        expect(resumed).toEqual({
          status: 200,
          body: { reopened: [thread.id], left: [], missing: [], restored: [] },
        });
        expect((yield* post(MACHINES_STOP_STATUS_PATH, {})).body).toEqual({
          machines: [{ id: hostId, name: NAME, online: true, wanted: false }],
        });

        // The thread's session is open again there, on the same conversation and folder.
        const second = yield* nthSession(thread.id, 2);
        expect(hostA.opened).toEqual([thread.id]);
        expect(hostB.opened).toEqual([thread.id]);
        expect(second.options.resumeId).toBe(sessionId);
        expect(second.options.fork).not.toBe(true);
        expect(second.options.cwd).toBe(volume.repo);
        expect(second.agentSessionId).toBe(sessionId);
        yield* second.emit({ type: "status", status: "idle" });
        yield* statusIs(thread.id, "idle");

        // And it continues: the next message goes to that session, and its turn ends.
        const runtimes = yield* ThreadRuntimes;
        yield* runtimes.send(thread.id, { text: "carry on" });
        yield* eventually(
          "the message on the new host",
          Effect.sync(() => second.sent.some((input) => input.text === "carry on")),
        );
        yield* second.completeTurn("finished");
        yield* statusIs(thread.id, "idle");
        const store = yield* ThreadStore;
        expect((yield* store.getThread(thread.id)).lastError).toBeUndefined();
        // The work the first host left is what the second one found.
        expect(run(volume.repo, "status", "--porcelain")).toContain("feature.ts");
        yield* hostB.end;
      }).pipe(Effect.scoped, Effect.provide(testLayer())),
    60_000,
  );

  it.live(
    "a message for a stopped machine says it is wanted, and goes once a host is started",
    () =>
      Effect.gen(function* () {
        const volume = makeVolume();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            removeDir(volume.dir);
            removeDir(volume.origin);
          }),
        );
        yield* hostedFeatures(true);
        const hostId = yield* joinMachine(volume);
        const hostA = yield* startHost(volume);
        const { thread, sessionId } = yield* workedThread(volume, hostId);
        expect((yield* post(MACHINES_STOP_PREPARE_PATH, { id: hostId })).body).toMatchObject({
          idle: true,
        });
        yield* statusIs(thread.id, "cold");
        yield* hostA.end;

        const runtimes = yield* ThreadRuntimes;
        yield* runtimes.send(thread.id, { text: "one more thing" }).pipe(Effect.forkScoped);
        yield* eventually(
          "the machine wanted",
          post(MACHINES_STOP_STATUS_PATH, {}).pipe(
            Effect.map((status) => status.body.machines?.[0]?.wanted === true),
          ),
        );
        const hostB = yield* startHost(volume);
        const second = yield* nthSession(thread.id, 2);
        expect(second.options.resumeId).toBe(sessionId);
        yield* second.emit({ type: "status", status: "idle" });
        yield* eventually(
          "the message on the new host",
          Effect.sync(() => second.sent.some((input) => input.text === "one more thing")),
        );
        yield* second.completeTurn("done");
        yield* statusIs(thread.id, "idle");
        expect((yield* post(MACHINES_STOP_STATUS_PATH, {})).body.machines?.[0]?.wanted).toBe(false);
        yield* hostB.end;
      }).pipe(Effect.scoped, Effect.provide(testLayer())),
    60_000,
  );

  it.live(
    "a message for a machine readied but not yet stopped waits, and goes when the stop is taken back",
    () =>
      Effect.gen(function* () {
        const volume = makeVolume();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            removeDir(volume.dir);
            removeDir(volume.origin);
          }),
        );
        yield* hostedFeatures(true);
        const hostId = yield* joinMachine(volume);
        const hostA = yield* startHost(volume);
        const { thread, sessionId } = yield* workedThread(volume, hostId);
        // A second thread there that was already at rest: the stop didn't rest it.
        const other = yield* workedThread(volume, hostId);
        const runtimes = yield* ThreadRuntimes;
        expect(yield* runtimes.restSession(other.thread.id)).toBe("rested");
        yield* statusIs(other.thread.id, "cold");
        expect((yield* post(MACHINES_STOP_PREPARE_PATH, { id: hostId })).body).toMatchObject({
          idle: true,
        });
        yield* statusIs(thread.id, "cold");

        // The host is still there and takes no work: the message waits, and says so.
        yield* runtimes.send(thread.id, { text: "not yet" }).pipe(Effect.forkScoped);
        yield* eventually(
          "the machine wanted",
          post(MACHINES_STOP_STATUS_PATH, {}).pipe(
            Effect.map((status) => status.body.machines?.[0]?.wanted === true),
          ),
        );
        expect(hostA.opened).toEqual([thread.id, other.thread.id]);
        expect((yield* post(MACHINES_STOP_CANCEL_PATH, { id: hostId })).status).toBe(200);
        const second = yield* nthSession(thread.id, 2);
        expect(second.options.resumeId).toBe(sessionId);
        yield* second.emit({ type: "status", status: "idle" });
        yield* eventually(
          "the message on the same host",
          Effect.sync(() => second.sent.some((input) => input.text === "not yet")),
        );
        yield* second.completeTurn("done");
        yield* statusIs(thread.id, "idle");
        // Taken back, nothing is left to resume: the thread at rest before the stop stays so.
        expect((yield* post(MACHINES_STOP_RESUME_PATH, { id: hostId })).body).toEqual({
          reopened: [],
          left: [],
          missing: [],
          restored: [],
        });
        expect(yield* runtimes.status(other.thread.id)).toBe("cold");
        yield* hostA.end;
      }).pipe(Effect.scoped, Effect.provide(testLayer())),
    60_000,
  );

  it.live(
    "a busy machine isn't readied, and a forced stop's cut turn goes on on the new host",
    () =>
      Effect.gen(function* () {
        const volume = makeVolume();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            removeDir(volume.dir);
            removeDir(volume.origin);
          }),
        );
        yield* hostedFeatures(true);
        const hostId = yield* joinMachine(volume);
        const hostA = yield* startHost(volume);
        const { thread, first, sessionId } = yield* workedThread(volume, hostId);
        const runtimes = yield* ThreadRuntimes;
        yield* runtimes.send(thread.id, { text: "a long job" });
        yield* eventually(
          "the second send",
          Effect.sync(() => first.sent.length === 2),
        );
        yield* first.emit({ type: "status", status: "running" });
        yield* statusIs(thread.id, "running");
        yield* eventually(
          "the host seeing its agent start the turn",
          Effect.sync(() => hostA.turns() === 1),
        );

        // Asked while it works: nothing is kept, nothing is put to rest.
        const refused = yield* post(MACHINES_STOP_PREPARE_PATH, { id: hostId });
        expect(refused.body).toMatchObject({ idle: false, kept: [], busy: { turns: 1 } });
        expect(run(volume.origin, "for-each-ref", "refs/gram/")).toBe("");
        expect(first.closed).toBe(false);

        // The machine is about to be taken away regardless: its work is kept, and it is not idle.
        const forced = yield* post(MACHINES_STOP_PREPARE_PATH, { id: hostId, force: true });
        expect(forced.body).toMatchObject({
          idle: false,
          working: [thread.id],
          kept: [{ pushed: true }],
        });
        expect(run(volume.origin, "show", `${wipRef(thread.id)}:feature.ts`)).toBe(
          "export const feature = 1;\n",
        );
        yield* hostA.end;

        const hostB = yield* startHost(volume);
        const second = yield* nthSession(thread.id, 2);
        expect(second.options.resumeId).toBe(sessionId);
        yield* second.emit({ type: "status", status: "idle" });
        yield* eventually(
          "the continuation",
          Effect.sync(() => second.sent.length === 1),
        );
        expect(second.sent[0]).toMatchObject({ text: machineRestartText(NAME) });
        yield* second.completeTurn("finished after the stop");
        yield* statusIs(thread.id, "idle");
        const store = yield* ThreadStore;
        expect((yield* store.getThread(thread.id)).lastError).toBeUndefined();
        yield* hostB.end;
      }).pipe(Effect.scoped, Effect.provide(testLayer())),
    60_000,
  );

  it.live(
    "with the hosted features off there are no stop routes, and an absent machine isn't waited for",
    () =>
      Effect.gen(function* () {
        const volume = makeVolume();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            removeDir(volume.dir);
            removeDir(volume.origin);
          }),
        );
        const hostId = yield* joinMachine(volume);
        const hostA = yield* startHost(volume);
        const { thread, first } = yield* workedThread(volume, hostId);
        for (const path of HOST_STOP_PATHS)
          expect((yield* post(path, { id: hostId })).status).toBe(404);
        expect(run(volume.origin, "for-each-ref", "refs/gram/")).toBe("");
        expect(first.closed).toBe(false);
        // At rest, as an idle thread ends up by itself, and its machine goes away.
        const runtimes = yield* ThreadRuntimes;
        expect(yield* runtimes.restSession(thread.id)).toBe("rested");
        yield* statusIs(thread.id, "cold");
        yield* hostA.end;

        // As ever: a message for a machine that is away fails at once, saying so.
        const started = Date.now();
        yield* runtimes.send(thread.id, { text: "anyone there?" }).pipe(Effect.exit);
        yield* statusIs(thread.id, "error");
        expect(Date.now() - started).toBeLessThan(10_000);
        const store = yield* ThreadStore;
        expect((yield* store.getThread(thread.id)).lastError?.text ?? "").toContain("offline");
        expect((yield* RemoteHosts).stops.wanted(hostId)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(testLayer())),
    60_000,
  );
});
