// A desktop Gram's worker machines from a hosted server the app is signed in to, with a fake app
// and a fake server over the port: no network, no real machine. The host is served for real, over
// the relayed connection the fake app carries, against the real machine registry.

import { describe, expect, it } from "@effect/vitest";
import { HOST_PROTOCOL_VERSION, HostId, type Thread, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import {
  generateHostKey,
  hostIdOf,
  privateKeyFrom,
  signedConnectHeaders,
} from "../host/machine-keys.ts";
import { holderOf } from "../host/ownership.ts";
import { forwardAppTools } from "../host/app-tools-forward.ts";
import { makeAppToolsTunnel, noAppToolsTunnel } from "../host/app-tools-tunnel.ts";
import { appToolsTunnel, machineHosts, type MachineDeps } from "../host/remote-worker-host.ts";
import { memoryMachineStore } from "../host/paired-machines.ts";
import { HOST_CAPABILITIES, type HostService, serveHost } from "../host/protocol.ts";
import { RemoteHosts } from "../host/remote-hosts.ts";
import { noAgents, sessionsOnHost } from "../host/sessions.ts";
import { terminalsOnHost } from "../host/terminals.ts";
import { workerMachine } from "../orchestration/service/spawning.ts";
import { Socket } from "../platform/unstable.ts";
import { releaseTeller, workerMachineWork } from "./worker-machine-release.ts";
import {
  bridgeWorkerMachines,
  forgetReclaimed,
  NO_SIGNED_IN_SERVER,
  plainName,
  RELAYED_MOST,
  SignedInWorkers,
  SignedInWorkersLive,
  signedInSource,
  WorkerMachinePort,
  type WorkerMachinePortShape,
} from "./signed-in-workers.ts";
import { ACCOUNT, fakeApp, NAME, ORIGIN, provisionRelayed, SERVER } from "./signed-in-fixtures.ts";

const none = () => Effect.die(new Error("not in this test"));

/** A host that says hello as `hostId` and has nothing else a test reaches. */
const service = (hostId: string, tunnel = true): Effect.Effect<HostService, never, Scope.Scope> =>
  Effect.gen(function* () {
    return {
      hello: {
        protocol: HOST_PROTOCOL_VERSION,
        hostId: HostId.make(hostId),
        capabilities: HOST_CAPABILITIES,
        features: tunnel ? ["app-tools-tunnel"] : [],
        platform: "linux",
        pid: 7,
      },
      appTools: yield* makeAppToolsTunnel,
      files: { list: none, search: none, names: none },
      worktrees: {
        list: none,
        baseBranches: none,
        create: none,
        remove: none,
        restore: none,
        pendingPermissions: none,
      },
      git: { local: none, present: none, watch: () => none() as never },
      terminals: yield* terminalsOnHost,
      sessions: yield* sessionsOnHost(noAgents),
      scan: Effect.succeed({ listening: new Map(), children: new Map() }),
    } as unknown as HostService;
  });

/** One app-tool call at a tunnel's address, as a session there makes it. */
const callTunnel = (url: string) =>
  Effect.tryPromise(() =>
    fetch(`${url}/host/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(3_000),
    }).then((response) => response.status),
  );

/** A host's side of a relayed connection: what it sends goes to the server as the app's frames. */
const relayedHost = (conn: string, toServer: (message: unknown) => void) => {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  let state = 1;
  const emit = (type: string, event: unknown) => {
    for (const listener of Array.from(listeners.get(type) ?? [])) listener(event);
  };
  const ws = {
    get readyState() {
      return state;
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.get(type)?.delete(listener);
    },
    send: (data: string | Uint8Array) => toServer({ type: "machines.relay.frame", conn, data }),
    close: () => {
      state = 3;
      toServer({ type: "machines.relay.end", conn });
      emit("close", { code: 1000, reason: "" });
    },
  };
  return {
    ws,
    fromServer: (message: Record<string, unknown>) => {
      if (message["conn"] !== conn) return;
      if (message["type"] === "machines.relay.frame") emit("message", { data: message["data"] });
      if (message["type"] === "machines.relay.end") {
        state = 3;
        emit("close", { code: (message["code"] as number | undefined) ?? 1000, reason: "" });
      }
    },
  };
};

describe("worker machines from a signed-in hosted server", () => {
  it.live(
    "asks the server, registers the machine from its status, takes its relayed dial and can place a worker on it",
    () =>
      Effect.gen(function* () {
        const hosts = yield* RemoteHosts.make(memoryMachineStore());
        const key = generateHostKey();
        const hostId = hostIdOf(key.publicKey);
        let started = false;
        let host: ReturnType<typeof relayedHost> | undefined;
        const serving: Array<Effect.Effect<void, never, Scope.Scope>> = [];
        const app = fakeApp({
          answer: ({ call }) => {
            if (call === "start") {
              started = true;
              return { status: 202, body: { name: NAME } };
            }
            if (call === "status")
              return started
                ? {
                    status: 200,
                    body: { phase: "joining", publicKey: key.publicKey, platform: "linux" },
                  }
                : { status: 404, body: {} };
            return { status: 200, body: {} };
          },
          // The server relays the host's dial: the app says so, with the headers the host signed.
          relayed: (name, toServer) => {
            const conn = "conn-0001";
            host = relayedHost(conn, toServer);
            const socket = host.ws;
            serving.push(
              Effect.gen(function* () {
                const made = yield* Socket.fromWebSocket(
                  Effect.succeed(socket as unknown as Socket.WebSocketLike),
                );
                yield* serveHost(made, yield* service(hostId));
              }).pipe(Effect.ignore),
            );
            toServer({
              type: "machines.relay.dial",
              conn,
              origin: ORIGIN,
              name,
              headers: signedConnectHeaders(privateKeyFrom(key.privateKeyPem), ORIGIN, hostId),
            });
          },
          fromServer: (message) => host?.fromServer(message),
        });
        const port = bridgeWorkerMachines(app.port);
        const context = yield* Layer.build(
          SignedInWorkersLive.pipe(
            Layer.provide(Layer.succeed(WorkerMachinePort)(port)),
            Layer.provide(Layer.succeed(RemoteHosts)(hosts)),
          ),
        );
        const signedIn = yield* SignedInWorkers.pipe(Effect.provide(context));
        const found = yield* signedIn.source;
        if ("refused" in found) throw new Error(found.refused);
        const source = found.source;
        // The host side starts serving once the app relays it.
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            while (serving.length === 0) yield* Effect.sleep("10 millis");
            yield* serving[0]!;
          }),
        );

        const asked = yield* source.start({
          name: NAME,
          orchestrator: "orchestrator-1",
          title: "Heavy build",
          size: "large",
        });
        expect(asked).toEqual({ kind: "started", name: NAME });
        // No owner goes from here: the server takes the person from the sign-in.
        expect(app.calls[0]).toEqual({
          call: "start",
          body: {
            name: NAME,
            title: "Heavy build",
            orchestrator: "orchestrator-1",
            choices: { size: "large" },
          },
        });

        const arrived = yield* source.arrive(NAME).pipe(Effect.timeout("10 seconds"));
        expect(arrived).toBe(hostId);
        const machine = hosts.list().find((each) => each.id === hostId)!;
        expect(machine).toMatchObject({
          name: NAME,
          kind: "provisioned",
          onDemand: "worker",
          via: ORIGIN,
        });
        expect(machine.onlineSince).toBeDefined();
        expect(machine).not.toHaveProperty("owner");
        expect(source.theirs(machine)).toBe(true);
        // The desktop's own, like a joined machine: open here, and a worker of an orchestrator on
        // this machine may go on it.
        expect(holderOf(machine)).toBeUndefined();
        expect(
          workerMachine(machine, { own: undefined, ownOwner: undefined, headless: false }),
        ).toEqual({ hostId });
        // Never on a headless Gram's, which has no desktop to own it.
        expect(
          workerMachine(machine, { own: undefined, ownOwner: undefined, headless: true }),
        ).toHaveProperty("error");

        // Its sessions reach their app tools at an address on the machine's own loopback, which
        // carries each call over the relayed connection to this Gram: never the hosted server's.
        const answered: Array<{ url: string; authorization?: string; body: string }> = [];
        const placed = { thread: "t-on-it", host: hostId };
        const url = yield* appToolsTunnel(
          HostId.make(hostId),
          yield* hosts.connection(HostId.make(hostId)),
          {
            appTools: forwardAppTools({
              tokens: {
                threadFor: (token) =>
                  Effect.succeed(
                    token === "token-on-it"
                      ? (placed.thread as ThreadId)
                      : token === "token-elsewhere"
                        ? ("t-elsewhere" as ThreadId)
                        : undefined,
                  ),
              },
              store: {
                getThread: (id) =>
                  Effect.succeed({
                    id,
                    checkout:
                      id === placed.thread
                        ? { hostId: placed.host, path: "/work" }
                        : { hostId: HostId.make("m-ffffffffffffffffffffffff"), path: "/work" },
                  } as unknown as Thread),
              },
              port: () => 4242,
              send: async (sentTo, init) => {
                answered.push({
                  url: sentTo,
                  ...(init.headers["authorization"] === undefined
                    ? {}
                    : { authorization: init.headers["authorization"] }),
                  body: init.body,
                });
                return {
                  status: 200,
                  headers: { "content-type": "application/json" },
                  body: '{"ok":true}',
                };
              },
            }),
          },
        );
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(url).not.toContain(new URL(ORIGIN).host);
        const call = (token: string) =>
          Effect.promise(() =>
            fetch(`${url}/host/mcp`, {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
            }).then(async (response) => ({ status: response.status, body: await response.text() })),
          );
        expect(yield* call("token-on-it")).toEqual({ status: 200, body: '{"ok":true}' });
        expect(answered).toEqual([
          {
            url: "http://127.0.0.1:4242/mcp",
            authorization: "Bearer token-on-it",
            body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
          },
        ]);
        // A token of a thread placed elsewhere, or none this Gram issued, goes no further.
        expect((yield* call("token-elsewhere")).status).toBe(401);
        expect((yield* call("token-unknown")).status).toBe(401);
        expect(answered).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.live(
    "refuses a machine whose gram-host carries no app tools as soon as it joins, and stops it",
    () =>
      Effect.gen(function* () {
        const hosts = yield* RemoteHosts.make(memoryMachineStore());
        const key = generateHostKey();
        const hostId = hostIdOf(key.publicKey);
        let host: ReturnType<typeof relayedHost> | undefined;
        const serving: Array<Effect.Effect<void, never, Scope.Scope>> = [];
        // The host side serves once the app relays it.
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            while (serving.length === 0) yield* Effect.sleep("10 millis");
            yield* serving[0]!;
          }),
        );
        const app = fakeApp({
          answer: ({ call }) =>
            call === "status"
              ? { status: 200, body: { phase: "joining", publicKey: key.publicKey } }
              : { status: 200, body: {} },
          relayed: (name, toServer) => {
            host = relayedHost("conn-older", toServer);
            const socket = host.ws;
            serving.push(
              Effect.gen(function* () {
                const made = yield* Socket.fromWebSocket(
                  Effect.succeed(socket as unknown as Socket.WebSocketLike),
                );
                // An older gram-host: everything else, but no app-tools-tunnel.
                yield* serveHost(made, yield* service(hostId, false));
              }).pipe(Effect.ignore),
            );
            toServer({
              type: "machines.relay.dial",
              conn: "conn-older",
              origin: ORIGIN,
              name,
              headers: signedConnectHeaders(privateKeyFrom(key.privateKeyPem), ORIGIN, hostId),
            });
          },
          fromServer: (message) => host?.fromServer(message),
        });
        const port = bridgeWorkerMachines(app.port);
        // Takes the relayed dial, as the desktop's server does.
        yield* Layer.build(
          SignedInWorkersLive.pipe(
            Layer.provide(Layer.succeed(WorkerMachinePort)(port)),
            Layer.provide(Layer.succeed(RemoteHosts)(hosts)),
          ),
        );
        const source = signedInSource(SERVER, { port, hosts, everyMs: 20, stopRetryMs: 10 });
        const arrived = yield* source.arrive(NAME).pipe(Effect.timeout("10 seconds"));
        expect(arrived).toEqual({ failed: noAppToolsTunnel(NAME) });
        // As a spawn does with an arrival that failed: given back.
        yield* source.abandon(NAME);
        expect(app.calls.at(-1)).toEqual({ call: "stop", body: { name: NAME } });
        expect(hosts.list().some((each) => each.name === NAME)).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.live("answers a relayed machine's app-tool calls on each connection, a redial's too", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const key = generateHostKey();
      const hostId = HostId.make(hostIdOf(key.publicKey));
      expect(
        hosts.machines.provision({
          name: NAME,
          publicKey: key.publicKey,
          platform: "linux",
          onDemand: "worker",
          via: ORIGIN,
        }).kind,
      ).toBe("provisioned");
      const routes = new Map<string, ReturnType<typeof relayedHost>>();
      const app = fakeApp({
        answer: () => ({ status: 200, body: {} }),
        fromServer: (message) => routes.get(message["conn"] as string)?.fromServer(message),
      });
      yield* Layer.build(
        SignedInWorkersLive.pipe(
          Layer.provide(Layer.succeed(WorkerMachinePort)(bridgeWorkerMachines(app.port))),
          Layer.provide(Layer.succeed(RemoteHosts)(hosts)),
        ),
      );
      // This Gram's machines as its server keeps them: no worker host is ever built here.
      yield* machineHosts(hosts, {
        appTools: () =>
          Effect.succeed({
            status: 200,
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
      } as unknown as MachineDeps);
      // One host process, which keeps its tunnel across its dials, as `dialForever` does.
      const hostService = yield* service(hostId);
      const connect = (conn: string) =>
        Effect.gen(function* () {
          const host = relayedHost(conn, app.toServer);
          routes.set(conn, host);
          const made = yield* Socket.fromWebSocket(
            Effect.succeed(host.ws as unknown as Socket.WebSocketLike),
          );
          yield* Effect.forkScoped(serveHost(made, hostService).pipe(Effect.ignore));
          app.toServer({
            type: "machines.relay.dial",
            conn,
            origin: ORIGIN,
            name: NAME,
            headers: signedConnectHeaders(privateKeyFrom(key.privateKeyPem), ORIGIN, hostId),
          });
          return host;
        });
      const onlineAs = (previous: unknown) =>
        Effect.gen(function* () {
          for (;;) {
            const now = yield* hosts.connection(hostId).pipe(Effect.option);
            if (now._tag === "Some" && now.value !== previous) return now.value;
            yield* Effect.sleep("20 millis");
          }
        }).pipe(Effect.timeout("10 seconds"));
      const first = yield* connect("conn-first");
      const before = yield* onlineAs(undefined);
      const url = (yield* before.appTools!.open).url;
      expect(yield* callTunnel(url)).toBe(200);
      // The relay drops and the host dials in again on a new connection.
      first.ws.close();
      yield* connect("conn-again");
      yield* onlineAs(before);
      expect(yield* callTunnel(url)).toBe(200);
    }).pipe(Effect.scoped),
  );

  it.live("stops answering an app-tool call the session there hung up on", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const key = generateHostKey();
      const hostId = HostId.make(hostIdOf(key.publicKey));
      hosts.machines.provision({
        name: NAME,
        publicKey: key.publicKey,
        platform: "linux",
        onDemand: "worker",
        via: ORIGIN,
      });
      const routes = new Map<string, ReturnType<typeof relayedHost>>();
      const app = fakeApp({
        answer: () => ({ status: 200, body: {} }),
        fromServer: (message) => routes.get(message["conn"] as string)?.fromServer(message),
      });
      yield* Layer.build(
        SignedInWorkersLive.pipe(
          Layer.provide(Layer.succeed(WorkerMachinePort)(bridgeWorkerMachines(app.port))),
          Layer.provide(Layer.succeed(RemoteHosts)(hosts)),
        ),
      );
      // A tool that waits on the user: it answers only once stopped, if it is.
      const seen = { started: 0, stopped: 0 };
      yield* machineHosts(hosts, {
        appTools: () =>
          Effect.sync(() => (seen.started += 1)).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Effect.sync(() => (seen.stopped += 1))),
          ),
      } as unknown as MachineDeps);
      const host = relayedHost("conn-long", app.toServer);
      routes.set("conn-long", host);
      const made = yield* Socket.fromWebSocket(
        Effect.succeed(host.ws as unknown as Socket.WebSocketLike),
      );
      yield* Effect.forkScoped(serveHost(made, yield* service(hostId)).pipe(Effect.ignore));
      app.toServer({
        type: "machines.relay.dial",
        conn: "conn-long",
        origin: ORIGIN,
        name: NAME,
        headers: signedConnectHeaders(privateKeyFrom(key.privateKeyPem), ORIGIN, hostId),
      });
      const connection = yield* Effect.gen(function* () {
        for (;;) {
          const now = yield* hosts.connection(hostId).pipe(Effect.option);
          if (now._tag === "Some") return now.value;
          yield* Effect.sleep("20 millis");
        }
      }).pipe(Effect.timeout("10 seconds"));
      const url = (yield* connection.appTools!.open).url;
      const hangUp = new AbortController();
      const calling = fetch(`${url}/host/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: "{}",
        signal: hangUp.signal,
      }).catch(() => "hung up");
      while (seen.started === 0) yield* Effect.sleep("20 millis");
      hangUp.abort();
      expect(yield* Effect.promise(() => calling)).toBe("hung up");
      yield* Effect.gen(function* () {
        while (seen.stopped === 0) yield* Effect.sleep("20 millis");
      }).pipe(Effect.timeout("5 seconds"));
      expect(seen).toEqual({ started: 1, stopped: 1 });
    }).pipe(Effect.scoped),
  );

  it.live("ends a relayed dial from another server, or signed for another, and takes no host", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const key = generateHostKey();
      const hostId = hostIdOf(key.publicKey);
      const signer = privateKeyFrom(key.privateKeyPem);
      expect(
        hosts.machines.provision({
          name: NAME,
          publicKey: key.publicKey,
          platform: "linux",
          onDemand: "worker",
          via: ORIGIN,
        }).kind,
      ).toBe("provisioned");
      const ended: Array<Record<string, unknown>> = [];
      const app = fakeApp({
        answer: () => ({ status: 200, body: {} }),
        fromServer: (message) => {
          if (message["type"] === "machines.relay.end") ended.push(message);
        },
      });
      yield* Layer.build(
        SignedInWorkersLive.pipe(
          Layer.provide(Layer.succeed(WorkerMachinePort)(bridgeWorkerMachines(app.port))),
          Layer.provide(Layer.succeed(RemoteHosts)(hosts)),
        ),
      );
      const other = "https://other.example.test";
      // Relayed by another server, signed for it.
      app.toServer({
        type: "machines.relay.dial",
        conn: "conn-other-server",
        origin: other,
        name: NAME,
        headers: signedConnectHeaders(signer, other, hostId),
      });
      // Relayed as from its own server, but signed for another: not a dial for here.
      app.toServer({
        type: "machines.relay.dial",
        conn: "conn-other-signed",
        origin: ORIGIN,
        name: NAME,
        headers: signedConnectHeaders(signer, other, hostId),
      });
      yield* Effect.sleep("100 millis");
      expect(ended.map((each) => [each["conn"], each["code"]])).toEqual([
        ["conn-other-server", 4401],
        ["conn-other-signed", 4401],
      ]);
      expect(hosts.list()[0]).not.toHaveProperty("onlineSince");
    }).pipe(Effect.scoped),
  );

  it.live("stops and forgets a machine that never joins, and says why", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const key = generateHostKey();
      const unrelayed: string[] = [];
      // It boots far enough to make its key, then never dials.
      const app = fakeApp({
        answer: ({ call }) =>
          call === "status"
            ? { status: 200, body: { phase: "joining", publicKey: key.publicKey } }
            : { status: 200, body: {} },
      });
      const port = bridgeWorkerMachines(app.port);
      const source = signedInSource(SERVER, {
        port: {
          ...port,
          unrelay: (name) => {
            unrelayed.push(name);
            port.unrelay(name);
          },
        },
        hosts,
        timeoutMs: 200,
        everyMs: 20,
      });
      const arrived = yield* source.arrive(NAME);
      expect(arrived).toEqual({ failed: "timeout" });
      expect(hosts.list().some((each) => each.name === NAME)).toBe(true);
      const words = yield* source.timedOut(NAME);
      expect(words).toMatch(/didn't join within \d+ minutes, so it was stopped/);
      expect(app.calls.map((each) => each.call)).toContain("stop");
      expect(app.calls.find((each) => each.call === "stop")?.body).toEqual({ name: NAME });
      expect(unrelayed).toEqual([NAME]);
      expect(hosts.list().some((each) => each.name === NAME)).toBe(false);
    }),
  );

  it.live("registers and relays a machine stopped after its host joined, which a dial wakes", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const key = generateHostKey();
      const relayed: string[] = [];
      // It failed after its host joined: stopped there, not failed, until the relay dials it.
      const app = fakeApp({
        answer: () => ({ status: 200, body: { phase: "stopped", publicKey: key.publicKey } }),
      });
      const port = bridgeWorkerMachines(app.port);
      const source = signedInSource(SERVER, {
        port: { ...port, relay: (_origin, name) => relayed.push(name) },
        hosts,
        timeoutMs: 200,
        everyMs: 20,
      });
      expect(yield* source.arrive(NAME)).toEqual({ failed: "timeout" });
      expect(hosts.list().some((each) => each.name === NAME)).toBe(true);
      expect(relayed).toEqual([NAME]);
    }),
  );

  it.live("starts once a machine the server says is paused before it registered here", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      // The server says phase alone of a machine that isn't running, key or not.
      const app = fakeApp({
        answer: ({ call }) =>
          call === "status"
            ? { status: 200, body: { phase: "stopped" } }
            : { status: 202, body: {} },
      });
      const source = signedInSource(SERVER, {
        port: bridgeWorkerMachines(app.port),
        hosts,
        timeoutMs: 300,
        everyMs: 20,
      });
      expect(yield* source.arrive(NAME)).toEqual({ failed: "timeout" });
      // Woken once with a start of its name, never stopped: still stopped after, it is waited for.
      expect(app.calls.filter((each) => each.call === "start").map((each) => each.body)).toEqual([
        { name: NAME },
      ]);
      expect(app.calls.map((each) => each.call)).not.toContain("stop");
    }),
  );

  it.live(
    "starts a reused machine the server says failed once, and tells when it fails again",
    () =>
      Effect.gen(function* () {
        const hosts = yield* RemoteHosts.make(memoryMachineStore());
        provisionRelayed(hosts, NAME);
        const unrelayed: string[] = [];
        const asleep = new Set<string>();
        // Failed there, and failed again after the start this asks for.
        const app = fakeApp({
          answer: ({ call }) =>
            call === "status"
              ? { status: 200, body: { phase: "failed", message: "Recovery failed." } }
              : { status: 202, body: {} },
        });
        const port = bridgeWorkerMachines(app.port);
        const source = signedInSource(SERVER, {
          port: { ...port, unrelay: (name) => unrelayed.push(name) },
          hosts,
          asleep,
          timeoutMs: 2_000,
          everyMs: 20,
        });
        const arrived = yield* source.arrive(NAME);
        expect(typeof arrived === "object" && arrived.failed !== "timeout").toBe(true);
        // One start of its name, `{name}` alone; never a stop: it may hold an earlier spawn's work.
        const starts = app.calls.filter((each) => each.call === "start");
        expect(starts.map((each) => each.body)).toEqual([{ name: NAME }]);
        expect(app.calls.map((each) => each.call)).not.toContain("stop");
        expect(unrelayed).toEqual([NAME]);
        expect([...asleep]).toEqual([NAME]);
      }),
  );

  it.live("says the server's own words when it stops starting the machine", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const app = fakeApp({
        answer: () => ({ status: 200, body: { phase: "failed", message: "Out of capacity." } }),
      });
      const source = signedInSource(SERVER, { port: bridgeWorkerMachines(app.port), hosts });
      expect(yield* source.arrive(NAME)).toEqual({
        failed: `The machine ${NAME} didn't join: Out of capacity.`,
      });
    }),
  );

  it.live("without a signed-in server that starts them, names the sign-in", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const app = fakeApp({
        server: {
          why: "No hosted server this computer is signed in to starts machines for its workers.",
        },
        answer: () => ({ status: 200, body: {} }),
      });
      const context = yield* Layer.build(
        SignedInWorkersLive.pipe(
          Layer.provide(Layer.succeed(WorkerMachinePort)(bridgeWorkerMachines(app.port))),
          Layer.provide(Layer.succeed(RemoteHosts)(hosts)),
        ),
      );
      const found = yield* (yield* SignedInWorkers.pipe(Effect.provide(context))).source;
      expect(found).toEqual({
        refused: `No hosted server this computer is signed in to starts machines for its workers. ${NO_SIGNED_IN_SERVER}`,
      });
      expect(NO_SIGNED_IN_SERVER).toMatch(/Sign in to a hosted server/);
    }).pipe(Effect.scoped),
  );

  it.effect("tells the signed-in server a finished worker's machine is released", () =>
    Effect.gen(function* () {
      const app = fakeApp({ answer: () => ({ status: 200, body: {} }) });
      const port = bridgeWorkerMachines(app.port);
      const machine = {
        id: "m-0123456789abcdef01234567",
        name: NAME,
        onDemand: "worker",
        via: ORIGIN,
        onlineSince: 0,
      };
      // Online long enough to judge, with no thread placed on it at work.
      const [work] = workerMachineWork([machine], [], new Set(), 60 * 60_000);
      expect(work).toEqual({ machine, over: true });
      const tell = releaseTeller(undefined, port)!;
      yield* tell(machine, true);
      expect(app.calls).toEqual([
        { call: "release", body: { name: NAME, released: true, reason: "finished" } },
      ]);
    }),
  );

  it.effect("takes a release as told only when the server applied it", () =>
    Effect.gen(function* () {
      // As a server answers a release of a name it holds no machine for.
      let answer = { status: 200, body: { known: false } as unknown };
      const app = fakeApp({ answer: () => answer });
      const tell = releaseTeller(undefined, bridgeWorkerMachines(app.port))!;
      const machine = {
        id: "m-0123456789abcdef01234567",
        name: NAME,
        onDemand: "worker",
        via: ORIGIN,
      };
      expect((yield* tell(machine, false).pipe(Effect.result))._tag).toBe("Failure");
      // Nor a 404: the server answers it for every machine while its backend is out of reach.
      answer = { status: 404, body: { code: "not_found" } };
      expect((yield* tell(machine, false).pipe(Effect.result))._tag).toBe("Failure");
      answer = { status: 200, body: { known: true, released: false } };
      expect((yield* tell(machine, false).pipe(Effect.result))._tag).toBe("Success");
    }),
  );

  it.live(
    "asks a machine that never joined to stop again, and says so when it never confirms",
    () =>
      Effect.gen(function* () {
        const hosts = yield* RemoteHosts.make(memoryMachineStore());
        const key = generateHostKey();
        const app = fakeApp({
          answer: ({ call }) =>
            call === "status"
              ? { status: 200, body: { phase: "joining", publicKey: key.publicKey } }
              : call === "stop"
                ? { status: 503, body: {} }
                : { status: 200, body: {} },
        });
        const source = signedInSource(SERVER, {
          port: bridgeWorkerMachines(app.port),
          hosts,
          timeoutMs: 100,
          everyMs: 20,
          stopRetryMs: 10,
          // Its stops are answered 503, which settles nothing: held, but not for this test.
          unansweredHoldMs: 0,
        });
        expect(yield* source.arrive(NAME)).toEqual({ failed: "timeout" });
        const words = yield* source.timedOut(NAME);
        expect(app.calls.filter((each) => each.call === "stop")).toHaveLength(3);
        expect(words).toMatch(/didn't confirm stopping it/);
        // Still registered, so the release pass tells the server its work is over.
        expect(hosts.list().some((each) => each.name === NAME)).toBe(true);
      }),
  );
});

describe("the relays a desktop's Gram asks the app to carry", () => {
  it.live("are told whole at start, and again when one is removed", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      provisionRelayed(hosts, NAME);
      const told: Array<Record<string, unknown>> = [];
      const app = fakeApp({ answer: () => ({ status: 200, body: {} }) });
      const port = bridgeWorkerMachines(app.port);
      const recording = {
        ...port,
        relays: (machines: ReadonlyArray<{ origin: string; name: string }>, fresh?: boolean) =>
          told.push({ machines, ...(fresh === true ? { fresh } : {}) }),
      };
      yield* Layer.build(
        SignedInWorkersLive.pipe(
          Layer.provide(Layer.succeed(WorkerMachinePort)(recording)),
          Layer.provide(Layer.succeed(RemoteHosts)(hosts)),
        ),
      );
      // Each carried under the sign-in it was asked for under alone.
      expect(told).toEqual([
        { machines: [{ origin: ORIGIN, name: NAME, account: ACCOUNT }], fresh: true },
      ]);
      // Removed by hand under Settings → Machines: the app is told to stop carrying it.
      hosts.remove(hosts.list()[0]!.id);
      expect(told.at(-1)).toEqual({ machines: [] });
    }).pipe(Effect.scoped),
  );

  it.live("stop carrying a machine the server says failed, and keep it registered", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      provisionRelayed(hosts, NAME);
      const told: Array<Record<string, unknown>> = [];
      // A recovery that failed before it joined again: failed on every dial until started again.
      const app = fakeApp({
        answer: ({ call }) =>
          call === "status"
            ? { status: 200, body: { phase: "failed", message: "Recovery failed." } }
            : { status: 200, body: {} },
      });
      const port = bridgeWorkerMachines(app.port);
      const recording = {
        ...port,
        relays: (machines: ReadonlyArray<{ origin: string; name: string }>, fresh?: boolean) =>
          told.push({ machines, ...(fresh === true ? { fresh } : {}) }),
      };
      yield* Layer.build(
        SignedInWorkersLive.pipe(
          Layer.provide(Layer.succeed(WorkerMachinePort)(recording)),
          Layer.provide(Layer.succeed(RemoteHosts)(hosts)),
        ),
      );
      while (!app.calls.some((each) => each.call === "status")) yield* Effect.sleep("10 millis");
      yield* Effect.sleep("20 millis");
      expect(told.at(-1)).toEqual({ machines: [] });
      expect(hosts.list().map((each) => each.name)).toEqual([NAME]);
    }).pipe(Effect.scoped),
  );

  it.live("forget a machine the server no longer knows, and ask nothing of one online", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      provisionRelayed(hosts, NAME);
      const unrelayed: string[] = [];
      const app = fakeApp({
        answer: ({ call }) =>
          call === "status"
            ? { status: 404, body: { code: "not_found" } }
            : { status: 200, body: {} },
      });
      const port = bridgeWorkerMachines(app.port);
      const misses = new Map<string, number>();
      const pass = forgetReclaimed(
        { ...port, unrelay: (name) => unrelayed.push(name) },
        hosts,
        misses,
      );
      // Once is a server that can't reach its workspace now as much as one that reclaimed it.
      yield* pass;
      yield* pass;
      expect(hosts.list()).toHaveLength(1);
      expect(unrelayed).toEqual([]);
      yield* pass;
      expect(app.calls).toHaveLength(3);
      expect(unrelayed).toEqual([NAME]);
      expect(hosts.list()).toEqual([]);
    }),
  );

  it.live("forget nothing of one sign-in's machine on what another sign-in is told", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      provisionRelayed(hosts, NAME);
      // Signed in there as someone else now: the app sends nothing asked under the first
      // sign-in, and the server would answer the second that it knows no such machine.
      const base = bridgeWorkerMachines(
        fakeApp({ answer: () => ({ status: 404, body: { code: "not_found" } }) }).port,
      );
      const asked: Array<string | undefined> = [];
      const port: WorkerMachinePortShape = {
        ...base,
        call: (origin, call, body, options) => {
          asked.push(options?.account);
          return options?.account === ACCOUNT
            ? Effect.succeed({ ok: false as const, why: "signed in as someone else" })
            : base.call(origin, call, body, options);
        },
      };
      const pass = forgetReclaimed(port, hosts, new Map());
      for (let each = 0; each < 4; each += 1) yield* pass;
      // Asked after under its own sign-in, which the app refused: still registered.
      expect(asked).toEqual([ACCOUNT, ACCOUNT, ACCOUNT, ACCOUNT]);
      expect(hosts.list().map((each) => each.name)).toEqual([NAME]);
    }),
  );

  it.live("forget no machine registered before sign-ins were kept on a not_found", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const key = generateHostKey();
      // As registered before: no sign-in kept with it, so whose it is there isn't known.
      hosts.machines.provision({
        name: NAME,
        publicKey: key.publicKey,
        platform: "linux",
        onDemand: "worker",
        via: ORIGIN,
      });
      const app = fakeApp({ answer: () => ({ status: 404, body: { code: "not_found" } }) });
      const pass = forgetReclaimed(bridgeWorkerMachines(app.port), hosts, new Map());
      for (let each = 0; each < 4; each += 1) yield* pass;
      expect(hosts.list().map((each) => each.name)).toEqual([NAME]);
    }),
  );

  it.live("keep a machine the server says is stopped, or answers a 404 not not_found", () =>
    Effect.gen(function* () {
      // Stopped: for work here to start again. A 404 of no machine's: a route not there now.
      for (const answer of [
        { status: 200, body: { phase: "stopped" } },
        { status: 404, body: {} },
      ]) {
        const hosts = yield* RemoteHosts.make(memoryMachineStore());
        provisionRelayed(hosts, NAME);
        const unrelayed: string[] = [];
        const app = fakeApp({ answer: () => answer });
        const port = bridgeWorkerMachines(app.port);
        const pass = forgetReclaimed({ ...port, unrelay: (name) => unrelayed.push(name) }, hosts);
        for (let each = 0; each < 4; each += 1) yield* pass;
        expect(unrelayed).toEqual([]);
        expect(hosts.list()).toHaveLength(1);
      }
    }),
  );

  it.live("take on one machine's relay that machine's dial alone", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const first = provisionRelayed(hosts, NAME);
      provisionRelayed(hosts, "worker-abcdef0123");
      const ended: Array<Record<string, unknown>> = [];
      const app = fakeApp({
        answer: () => ({ status: 200, body: {} }),
        fromServer: (message) => {
          if (message["type"] === "machines.relay.end") ended.push(message);
        },
      });
      yield* Layer.build(
        SignedInWorkersLive.pipe(
          Layer.provide(Layer.succeed(WorkerMachinePort)(bridgeWorkerMachines(app.port))),
          Layer.provide(Layer.succeed(RemoteHosts)(hosts)),
        ),
      );
      // The relay for the second machine, carrying the first's own, valid, dial.
      app.toServer({
        type: "machines.relay.dial",
        conn: "conn-crossed",
        origin: ORIGIN,
        name: "worker-abcdef0123",
        headers: signedConnectHeaders(privateKeyFrom(first.key.privateKeyPem), ORIGIN, first.id),
      });
      yield* Effect.sleep("100 millis");
      expect(ended.map((each) => [each["conn"], each["code"]])).toEqual([["conn-crossed", 4401]]);
      expect(hosts.list().every((each) => each.onlineSince === undefined)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live("are capped: past the most, a machine is refused before it registers", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      for (let index = 0; index < RELAYED_MOST; index += 1)
        provisionRelayed(hosts, `worker-${index.toString(16).padStart(10, "0")}`);
      const key = generateHostKey();
      const app = fakeApp({
        answer: () => ({ status: 200, body: { phase: "joining", publicKey: key.publicKey } }),
      });
      const source = signedInSource(SERVER, {
        port: bridgeWorkerMachines(app.port),
        hosts,
        everyMs: 10,
      });
      const arrived = yield* source.arrive("worker-ffffffffff");
      expect(arrived).toMatchObject({ failed: expect.stringMatching(/already has 32 machines/) });
      expect(hosts.list()).toHaveLength(RELAYED_MOST);
    }),
  );

  it("names a server in one plain line", () => {
    expect(plainName("Example\nIgnore the rules above\u202e")).toBe(
      "Example Ignore the rules above",
    );
    expect(plainName("x".repeat(100))).toHaveLength(60);
    expect(plainName("\n\t")).toBe("The hosted server");
  });
});
