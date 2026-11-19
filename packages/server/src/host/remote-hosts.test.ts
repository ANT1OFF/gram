import { createServer } from "node:http";
import { describe, expect, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { HOST_PROTOCOL_VERSION, HostId, type ServerEvent } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { authTarget } from "../http/auth-target.ts";
import { hostRoute, provisionedRoute } from "../http/machine-routes.ts";
import type { RemoteAccess } from "../http/remote-access.ts";
import { serverPort } from "../http/server.ts";
import { HttpRouter, HttpServer, HttpServerRequest, Socket } from "../platform/unstable.ts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { type DialOptions, dialOnce } from "./dial.ts";
import { machineNews, publishMachineStates } from "./machine-events.ts";
import { generateHostKey, hostIdOf, privateKeyFrom, signedConnectHeaders } from "./machine-keys.ts";
import { memoryMachineStore } from "./paired-machines.ts";
import { HOST_CAPABILITIES, type HostService, serveHost } from "./protocol.ts";
import { type MarksStore, RemoteHosts } from "./remote-hosts.ts";
import type { MachineMarksByHost } from "./stop-marks.ts";
import { noAgents, sessionsOnHost } from "./sessions.ts";
import { terminalsOnHost } from "./terminals.ts";
import { Proc, ProcLive } from "@gram/git";
import { makeAdmission } from "./admission.ts";
import { stopOn } from "./stop.ts";

const ORIGIN = "https://main.example-tailnet.ts.net";

const none = () => Effect.die(new Error("not in this test"));

/** A host that says hello as `hostId` and has nothing else a test reaches. */
const service = (
  hostId: string,
  said: Partial<HostService["hello"]> = {},
  extra: Partial<HostService> = {},
): Effect.Effect<HostService, never, Scope.Scope> =>
  Effect.gen(function* () {
    return {
      hello: {
        protocol: HOST_PROTOCOL_VERSION,
        hostId: HostId.make(hostId),
        capabilities: HOST_CAPABILITIES,
        platform: "linux",
        pid: 7,
        ...said,
      },
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
      ...extra,
    } as unknown as HostService;
  });

/**
 * The machines' two routes on loopback, answering as if over the tailnet address. `duringUpgrade`
 * runs as a dial's WebSocket upgrade does, after the route let it through and before it attaches.
 */
const servedWith = (
  duringUpgrade?: (hosts: RemoteHosts["Service"]) => void,
  options: { readonly pingEveryMs?: number; readonly marks?: MarksStore } = {},
) =>
  Effect.gen(function* () {
    const hosts = yield* RemoteHosts.make(memoryMachineStore(), undefined, undefined, options);
    /** How many dials the route has finished with. */
    let finished = 0;
    const context = yield* Layer.build(
      HttpRouter.serve(
        HttpRouter.add(
          "*",
          "/host/*",
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const remote = { host: request.headers["host"], origin: ORIGIN } as RemoteAccess;
            const upgrading: HttpServerRequest.HttpServerRequest =
              duringUpgrade === undefined
                ? request
                : Object.create(request, {
                    upgrade: {
                      value: Effect.andThen(
                        Effect.sync(() => duringUpgrade(hosts)),
                        request.upgrade,
                      ),
                    },
                  });
            return yield* hostRoute(hosts, remote, authTarget(request.url)?.path ?? "").pipe(
              Effect.provideService(HttpServerRequest.HttpServerRequest, upgrading),
              Effect.ensuring(
                Effect.sync(() => {
                  if (authTarget(request.url)?.path === "/host/connect") finished += 1;
                }),
              ),
            );
          }),
        ),
        { disableListenLog: true, disableLogger: true },
      ).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      ),
    ).pipe(Effect.orDie);
    const port = serverPort(Context.get(context, HttpServer.HttpServer));
    return { hosts, port, base: `http://127.0.0.1:${port}`, finished: () => finished };
  });

const served = servedWith();

/**
 * A host that holds back its hello: `reading` is done once it has its socket and would read, and it
 * reads nothing until `release` is.
 */
const heldHello = (dial: DialOptions, hostId: string) =>
  Effect.gen(function* () {
    const reading = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const run = Effect.gen(function* () {
      const socket = yield* Socket.makeWebSocket(dial.url!, {
        headers: signedConnectHeaders(dial.key, dial.origin, dial.hostId),
      });
      let first = true;
      const held: Socket.Socket = {
        ...socket,
        reader: Effect.map(socket.reader, (reader) => ({
          ...reader,
          pull: Effect.suspend(() => {
            if (!first) return reader.pull;
            first = false;
            return Deferred.succeed(reading, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(reader.pull),
            );
          }),
        })),
      };
      yield* serveHost(held, yield* service(hostId));
    }).pipe(Effect.scoped, Effect.provide(NodeSocket.layerWebSocketConstructor));
    return { run, reading, release };
  });

/** Polls on real time until `check` holds, or fails the test after `seconds`. */
const waitUntil = (label: string, check: () => boolean, seconds = 10) =>
  Effect.gen(function* () {
    const deadline = Date.now() + seconds * 1000;
    while (!check()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error(`timed out: ${label}`));
      yield* Effect.sleep("10 millis");
    }
  });

/**
 * A host that can be stalled: while it is, it reads nothing, so it answers no ping, as a host does
 * whose machine is swapping or whose disk is saturated. `stall` holds it for `ms` from now.
 */
const stallingHost = (dial: DialOptions, hostId: string) => {
  let until = 0;
  const run = Effect.gen(function* () {
    const socket = yield* Socket.makeWebSocket(dial.url!, {
      headers: signedConnectHeaders(dial.key, dial.origin, dial.hostId),
    });
    const held: Socket.Socket = {
      ...socket,
      reader: Effect.map(socket.reader, (reader) => ({
        ...reader,
        pull: Effect.suspend(() => {
          const wait = until - Date.now();
          return wait > 0 ? Effect.andThen(Effect.sleep(wait), reader.pull) : reader.pull;
        }),
      })),
    };
    yield* serveHost(held, yield* service(hostId));
  }).pipe(Effect.scoped, Effect.provide(NodeSocket.layerWebSocketConstructor));
  return {
    run,
    stall: (ms: number) => {
      until = Date.now() + ms;
    },
  };
};

/** The machine's connection, once it has dialled in. */
const online = (hosts: RemoteHosts["Service"], hostId: string) =>
  Effect.gen(function* () {
    while (true) {
      const exit = yield* Effect.exit(hosts.connection(HostId.make(hostId)));
      if (exit._tag === "Success") return exit.value;
      yield* Effect.sleep("50 millis");
    }
  }).pipe(Effect.timeout("10 seconds"));

const joinMachine = (base: string, code: string, publicKey: string) =>
  Effect.promise(() =>
    fetch(`${base}/host/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: "build box", platform: "linux", publicKey }),
    }).then(async (response) => ({ status: response.status, body: await response.text() })),
  );

/** A machine joined over the route and confirmed, with what it dials with. */
const joinedAndConfirmed = (hosts: RemoteHosts["Service"], base: string) =>
  Effect.gen(function* () {
    const key = generateHostKey();
    const hostId = hostIdOf(key.publicKey);
    const { url } = hosts.machines.mint(ORIGIN);
    const code = new URLSearchParams(new URL(url).hash.slice(1)).get("code")!;
    yield* joinMachine(base, code, key.publicKey);
    hosts.machines.confirm(hostId);
    const dial: DialOptions = {
      origin: ORIGIN,
      hostId,
      key: privateKeyFrom(key.privateKeyPem),
      url: `${base.replace("http:", "ws:")}/host/connect`,
    };
    return { hostId, dial };
  });

describe("joined machines over the network", () => {
  it.live(
    "joins with the link's code, waits for confirmation, then dials in and says hello",
    () =>
      Effect.gen(function* () {
        const { hosts, base } = yield* served;
        const key = generateHostKey();
        const hostId = hostIdOf(key.publicKey);
        const { url } = hosts.machines.mint(ORIGIN);
        const code = new URLSearchParams(new URL(url).hash.slice(1)).get("code")!;

        // A wrong code is refused and leaves the link usable.
        expect((yield* joinMachine(base, "0".repeat(64), key.publicKey)).status).toBe(403);
        const joined = yield* joinMachine(base, code, key.publicKey);
        expect(joined).toEqual({ status: 200, body: JSON.stringify({ hostId }) });
        // Single use.
        expect((yield* joinMachine(base, code, generateHostKey().publicKey)).status).toBe(403);

        const dial = {
          origin: ORIGIN,
          hostId,
          key: privateKeyFrom(key.privateKeyPem),
          url: `${base.replace("http:", "ws:")}/host/connect`,
        };
        // Not confirmed yet: the dial is refused and ends.
        yield* dialOnce(dial, service(hostId));
        expect(Effect.runSync(Effect.exit(hosts.connection(HostId.make(hostId))))._tag).toBe(
          "Failure",
        );

        hosts.machines.confirm(hostId);
        const fiber = yield* Effect.forkScoped(dialOnce(dial, service(hostId)));
        const connection = yield* online(hosts, hostId);
        expect(connection.hello).toMatchObject({ hostId, platform: "linux", pid: 7 });
        expect(hosts.list()).toEqual([
          expect.objectContaining({ id: hostId, name: "build box", confirmed: true }),
        ]);
        expect(hosts.list()[0]).toHaveProperty("onlineSince");

        // Removing the machine closes its connection and forgets its key.
        hosts.remove(HostId.make(hostId));
        yield* Fiber.join(fiber).pipe(Effect.timeout("10 seconds"));
        expect(hosts.list()).toEqual([]);
        expect(Effect.runSync(Effect.exit(hosts.connection(HostId.make(hostId))))._tag).toBe(
          "Failure",
        );
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live(
    "publishes a machine's state as it is confirmed, dials in, drops and is removed, each once",
    () =>
      Effect.gen(function* () {
        const { hosts, base } = yield* served;
        const sent: Array<Extract<ServerEvent, { type: "machines.snapshot" }>> = [];
        yield* publishMachineStates(
          {
            publish: (event) =>
              Effect.sync(() => {
                if (event.type === "machines.snapshot") sent.push(event);
              }),
          },
          hosts,
        );
        /** The latest snapshot's machines, once one satisfies `ready`. */
        const latest = (ready: (machines: (typeof sent)[number]["machines"]) => boolean) =>
          Effect.gen(function* () {
            while (true) {
              const machines = sent.at(-1)?.machines;
              if (machines !== undefined && ready(machines)) return machines;
              yield* Effect.sleep("20 millis");
            }
          }).pipe(Effect.timeout("10 seconds"));

        // Joined but not confirmed, it gets no work, so no thread can name it: nothing is sent.
        const key = generateHostKey();
        const hostId = hostIdOf(key.publicKey);
        const { url } = hosts.machines.mint(ORIGIN);
        const code = new URLSearchParams(new URL(url).hash.slice(1)).get("code")!;
        yield* joinMachine(base, code, key.publicKey);
        yield* Effect.sleep("50 millis");
        expect(sent).toEqual([]);
        expect(hosts.states()).toEqual([]);

        hosts.machines.confirm(hostId);
        expect(yield* latest((machines) => machines.length === 1)).toEqual([
          { id: hostId, name: "build box", kind: "joined", offline: { kind: "never" } },
        ]);
        expect(sent).toHaveLength(1);

        const dial: DialOptions = {
          origin: ORIGIN,
          hostId,
          key: privateKeyFrom(key.privateKeyPem),
          url: `${base.replace("http:", "ws:")}/host/connect`,
        };
        const fiber = yield* Effect.forkScoped(dialOnce(dial, service(hostId)));
        yield* online(hosts, hostId);
        const up = yield* latest((machines) => machines[0]?.onlineSince !== undefined);
        expect(up).toEqual([
          { id: hostId, name: "build box", kind: "joined", onlineSince: expect.any(Number) },
        ]);
        expect(sent).toHaveLength(2);

        // A change that leaves the states as they were sent publishes nothing.
        const before = sent.length;
        hosts.accessFrom(() => "on");
        yield* Effect.sleep("50 millis");
        expect(sent).toHaveLength(before);

        // Its connection drops: offline, with why.
        yield* Fiber.interrupt(fiber);
        const down = yield* latest((machines) => machines[0]?.offline !== undefined);
        expect(down).toEqual([
          {
            id: hostId,
            name: "build box",
            kind: "joined",
            offline: { kind: "lost", at: expect.any(Number) },
          },
        ]);
        expect(sent).toHaveLength(3);

        // Access over Tailscale turned off explains it better than the loss.
        hosts.accessFrom(() => "off");
        expect(
          yield* latest((machines) => machines[0]?.offline?.kind === "tailscale-off"),
        ).toHaveLength(1);

        expect(sent).toHaveLength(4);

        // Why Tailscale is down here changes with no word to the registry, so it is never the
        // pushed reason: only the switch is.
        hosts.accessFrom(() => "stopped");
        expect(yield* latest((machines) => machines[0]?.offline?.kind === "lost")).toHaveLength(1);
        expect(sent).toHaveLength(5);

        hosts.remove(HostId.make(hostId));
        expect(yield* latest((machines) => machines.length === 0)).toEqual([]);
        expect(sent).toHaveLength(6);
      }).pipe(Effect.scoped),
    20_000,
  );

  it("counts a refused dial as news once, however often it repeats", () => {
    const id = HostId.make("m-0123456789abcdef01234567");
    const refused = (at: number) =>
      machineNews([
        { id, name: "build box", kind: "joined", offline: { kind: "bad-signature", at } },
      ]);
    // Anyone on the tailnet who knows the id can repeat this: only its time differs.
    expect(refused(2)).toBe(refused(1));
    const skewed = (at: number, skewMs: number) =>
      machineNews([
        { id, name: "build box", kind: "joined", offline: { kind: "clock", at, skewMs } },
      ]);
    expect(skewed(2, 180_400)).toBe(skewed(1, 180_000));
    expect(skewed(2, 300_000)).not.toBe(skewed(1, 180_000));
    // A connection that closed is news each time it does.
    const lost = (at: number) =>
      machineNews([{ id, name: "build box", kind: "joined", offline: { kind: "lost", at } }]);
    expect(lost(2)).not.toBe(lost(1));
    expect(refused(1)).not.toBe(lost(1));
  });

  it.live("refuses a dial signed by another key, or for another Gram", () =>
    Effect.gen(function* () {
      const { hosts, base } = yield* served;
      const key = generateHostKey();
      const hostId = hostIdOf(key.publicKey);
      const { url } = hosts.machines.mint(ORIGIN);
      const code = new URLSearchParams(new URL(url).hash.slice(1)).get("code")!;
      yield* joinMachine(base, code, key.publicKey);
      hosts.machines.confirm(hostId);
      const wsUrl = `${base.replace("http:", "ws:")}/host/connect`;
      const stranger = privateKeyFrom(generateHostKey().privateKeyPem);
      yield* dialOnce({ origin: ORIGIN, hostId, key: stranger, url: wsUrl }, service(hostId));
      yield* dialOnce(
        {
          origin: "https://other.example-tailnet.ts.net",
          hostId,
          key: privateKeyFrom(key.privateKeyPem),
          url: wsUrl,
        },
        service(hostId),
      );
      expect(hosts.list()[0]).not.toHaveProperty("onlineSince");
    }).pipe(Effect.scoped),
  );

  it.live("keeps a machine removed while it says hello offline", () =>
    Effect.gen(function* () {
      const { hosts, base, finished } = yield* served;
      const { hostId, dial } = yield* joinedAndConfirmed(hosts, base);
      const host = yield* heldHello(dial, hostId);
      yield* Effect.forkScoped(host.run);
      yield* Deferred.await(host.reading);
      hosts.remove(HostId.make(hostId));
      // Its hello arrives after the removal: the dial ends without bringing it back.
      yield* Deferred.succeed(host.release, undefined);
      yield* waitUntil("the dial to end", () => finished() === 1);
      expect(hosts.list()).toEqual([]);
      expect(Effect.runSync(Effect.exit(hosts.connection(HostId.make(hostId))))._tag).toBe(
        "Failure",
      );
    }).pipe(Effect.scoped),
  );

  it.live("lists what a machine can run once it is online, and again when asked", () =>
    Effect.gen(function* () {
      const { hosts, base } = yield* served;
      const { hostId, dial } = yield* joinedAndConfirmed(hosts, base);
      let state: "notSignedIn" | "signedIn" = "notSignedIn";
      const status = Effect.sync(() => ({
        claudeSignIn: state,
        tools: [{ tool: "claude" as const, found: true, version: "2.1.319" }],
      }));
      yield* Effect.forkScoped(dialOnce(dial, service(hostId, {}, { status })));
      yield* online(hosts, hostId);
      // Asked as it comes online; offline, nothing is said about it.
      while (hosts.list()[0]?.claudeSignIn === undefined) yield* Effect.sleep("20 millis");
      expect(hosts.list()[0]).toMatchObject({
        claudeSignIn: "notSignedIn",
        tools: [{ tool: "claude", found: true, version: "2.1.319" }],
      });
      state = "signedIn";
      expect(yield* Effect.promise(() => hosts.checkSignIn(HostId.make(hostId)))).toMatchObject({
        claudeSignIn: "signedIn",
      });
      expect(hosts.list()[0]).toMatchObject({ claudeSignIn: "signedIn" });
      hosts.keepOrigin(undefined);
      while (hosts.list()[0]?.onlineSince !== undefined) yield* Effect.sleep("20 millis");
      expect(hosts.list()[0]).not.toHaveProperty("claudeSignIn");
      expect(hosts.list()[0]).not.toHaveProperty("tools");
      expect(yield* Effect.promise(() => hosts.checkSignIn(HostId.make(hostId)))).toBeUndefined();
    }).pipe(Effect.scoped, Effect.timeout("15 seconds")),
  );

  it.live("closes machines' connections when access moves off their address", () =>
    Effect.gen(function* () {
      const { hosts, base } = yield* served;
      const { hostId, dial } = yield* joinedAndConfirmed(hosts, base);
      const fiber = yield* Effect.forkScoped(dialOnce(dial, service(hostId)));
      yield* online(hosts, hostId);
      hosts.keepOrigin(ORIGIN);
      expect(hosts.list()[0]).toHaveProperty("onlineSince");
      hosts.keepOrigin(undefined);
      yield* Fiber.join(fiber).pipe(Effect.timeout("10 seconds"));
      expect(hosts.list()).toEqual([expect.objectContaining({ id: hostId, confirmed: true })]);
      expect(hosts.list()[0]).not.toHaveProperty("onlineSince");
    }).pipe(Effect.scoped),
  );

  // Joined-machines audit A1: a dial let through, then access turned off or moved while its
  // upgrade ran, came online over the address that no longer had access.
  for (const [what, moved] of [
    ["turned off", undefined],
    ["moved to another address", "https://other.example-tailnet.ts.net"],
  ] as const)
    it.live(`keeps a dial offline when access is ${what} while it upgrades`, () =>
      Effect.gen(function* () {
        let move = false;
        const { hosts, base, finished } = yield* servedWith((them) => {
          if (move) them.keepOrigin(moved);
        });
        const { hostId, dial } = yield* joinedAndConfirmed(hosts, base);
        move = true;
        const fiber = yield* Effect.forkScoped(dialOnce(dial, service(hostId)));
        while (finished() === 0 && hosts.list()[0]?.onlineSince === undefined)
          yield* Effect.sleep("50 millis");
        expect(hosts.list()[0]).not.toHaveProperty("onlineSince");
        // Its socket is closed, so the machine dials again rather than wait on it.
        yield* Fiber.join(fiber);
        expect(Effect.runSync(Effect.exit(hosts.connection(HostId.make(hostId))))._tag).toBe(
          "Failure",
        );
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
    );

  it.live("still lets a dial in over the address access was kept on", () =>
    Effect.gen(function* () {
      const { hosts, base } = yield* served;
      const { hostId, dial } = yield* joinedAndConfirmed(hosts, base);
      hosts.keepOrigin(undefined);
      hosts.keepOrigin(ORIGIN);
      yield* Effect.forkScoped(dialOnce(dial, service(hostId)));
      yield* online(hosts, hostId);
      expect(hosts.list()[0]).toHaveProperty("onlineSince");
    }).pipe(Effect.scoped),
  );

  it.live(
    "ends a dial still saying hello when access is turned off, without waiting for its hello",
    () =>
      Effect.gen(function* () {
        const { hosts, base, finished } = yield* served;
        const { hostId, dial } = yield* joinedAndConfirmed(hosts, base);
        const host = yield* heldHello(dial, hostId);
        yield* Effect.forkScoped(host.run);
        yield* Deferred.await(host.reading);
        expect(finished()).toBe(0);
        hosts.keepOrigin(undefined);
        // Ended while the hello is still held, not when it arrives.
        yield* waitUntil("the dial to end", () => finished() === 1);
        yield* Deferred.succeed(host.release, undefined);
        yield* Effect.sleep("100 millis");
        expect(hosts.list()[0]).not.toHaveProperty("onlineSince");
      }).pipe(Effect.scoped),
  );

  it.live(
    "says a machine whose host speaks another protocol needs an update, with its release",
    () =>
      Effect.gen(function* () {
        const { hosts, base } = yield* served;
        const { hostId, dial } = yield* joinedAndConfirmed(hosts, base);
        yield* dialOnce(
          dial,
          service(hostId, { protocol: HOST_PROTOCOL_VERSION + 1, release: "1.17.0" }),
        );
        expect(hosts.list("on")[0]).toMatchObject({
          offline: { kind: "mismatch", protocol: HOST_PROTOCOL_VERSION + 1 },
          release: "1.17.0",
        });
        expect(hosts.list("on")[0]).not.toHaveProperty("onlineSince");
        // A release that doesn't read as one isn't kept.
        yield* dialOnce(
          dial,
          service(hostId, { protocol: HOST_PROTOCOL_VERSION + 1, release: "<b>1.17</b>" }),
        );
        expect(hosts.list("on")[0]).not.toHaveProperty("release");
        // A host from before releases were sent, and short of what this build needs.
        yield* dialOnce(dial, service(hostId, { capabilities: ["files", "git"] }));
        const offline = hosts.list("on")[0]!.offline;
        expect(offline).toMatchObject({ kind: "mismatch", protocol: HOST_PROTOCOL_VERSION });
        expect(offline).toHaveProperty("missing", expect.arrayContaining(["sessions", "repos"]));
        expect(offline).not.toHaveProperty("release");
      }).pipe(Effect.scoped),
  );

  it.live("comes online with its release, which clears why it was offline", () =>
    Effect.gen(function* () {
      const { hosts, base } = yield* served;
      const { hostId, dial } = yield* joinedAndConfirmed(hosts, base);
      expect(hosts.list("on")[0]?.offline).toEqual({ kind: "never" });
      expect(hosts.list("off")[0]?.offline).toEqual({ kind: "tailscale-off" });
      yield* dialOnce(dial, service(hostId, { protocol: HOST_PROTOCOL_VERSION + 1 }));
      const fiber = yield* Effect.forkScoped(
        dialOnce(dial, service(hostId, { release: "1.15.2" })),
      );
      yield* online(hosts, hostId);
      expect(hosts.list("on")[0]).toMatchObject({ release: "1.15.2" });
      expect(hosts.list("on")[0]).not.toHaveProperty("offline");
      expect(hosts.machines.problemOf(hostId)).toBeUndefined();
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );

  it.live("says a host that answered as another machine didn't say hello", () =>
    Effect.gen(function* () {
      const { hosts, base } = yield* served;
      const { hostId, dial } = yield* joinedAndConfirmed(hosts, base);
      yield* dialOnce(dial, service(hostId, { hostId: HostId.make(`m-${"0".repeat(24)}`) }));
      expect(hosts.list("on")[0]?.offline).toMatchObject({ kind: "no-hello" });
    }).pipe(Effect.scoped),
  );

  it.live("says when a machine's connection was lost, or access moved off its address", () =>
    Effect.gen(function* () {
      const { hosts, base } = yield* served;
      const { hostId, dial } = yield* joinedAndConfirmed(hosts, base);
      // The host's end goes: its dial ends, and the main Gram sees the connection close.
      const fiber = yield* Effect.forkScoped(dialOnce(dial, service(hostId)));
      yield* online(hosts, hostId);
      yield* Fiber.interrupt(fiber);
      while (hosts.list("on")[0]?.offline === undefined) yield* Effect.sleep("50 millis");
      expect(hosts.list("on")[0]?.offline).toMatchObject({ kind: "lost" });

      yield* Effect.forkScoped(dialOnce(dial, service(hostId)));
      yield* online(hosts, hostId);
      hosts.keepOrigin("https://moved.example-tailnet.ts.net");
      yield* waitUntil("moved", () => hosts.list("on")[0]?.offline?.kind === "moved");
      expect(hosts.list("on")[0]?.offline).toMatchObject({ kind: "moved" });

      // Access turned off and on again before it redials: its connection was lost then. Access
      // moves back to the address it dials first, as only a dial over that address comes online.
      hosts.keepOrigin(ORIGIN);
      yield* Effect.forkScoped(dialOnce(dial, service(hostId)));
      yield* online(hosts, hostId);
      hosts.keepOrigin(undefined);
      yield* waitUntil("off", () => hosts.list("off")[0]?.offline?.kind === "tailscale-off");
      expect(hosts.list("off")[0]?.offline).toEqual({ kind: "tailscale-off" });
      expect(hosts.list("on")[0]?.offline).toMatchObject({ kind: "lost" });

      // Removed while online: nothing is kept for it.
      hosts.keepOrigin(ORIGIN);
      yield* Effect.forkScoped(dialOnce(dial, service(hostId)));
      yield* online(hosts, hostId);
      hosts.remove(HostId.make(hostId));
      yield* Effect.sleep("200 millis");
      expect(hosts.machines.problemOf(hostId)).toBeUndefined();
    }).pipe(Effect.scoped),
  );
});

describe("a joined machine that stalls", () => {
  // Pings every 300 ms here, so the host may miss four (1.2 s) before it counts as gone.
  const PING_EVERY_MS = 300;

  it.live("stays online through a stall of a few missed pings", () =>
    Effect.gen(function* () {
      const { hosts, base } = yield* servedWith(undefined, { pingEveryMs: PING_EVERY_MS });
      const { hostId, dial } = yield* joinedAndConfirmed(hosts, base);
      const host = stallingHost(dial, hostId);
      yield* Effect.forkScoped(host.run);
      const before = yield* online(hosts, hostId);
      // Three and a half pings unanswered. Before, the connection ended once one ping went
      // unanswered past the next, and a machine under load dropped every minute or so.
      host.stall(PING_EVERY_MS * 3.5);
      yield* Effect.sleep(PING_EVERY_MS * 4.5);
      // It still answers: a call over the same connection gets through.
      const scanned = yield* before.scan.pipe(Effect.timeout("2 seconds"), Effect.exit);
      expect(scanned._tag).toBe("Success");
      expect(before.gone()).toBe(false);
      expect(yield* online(hosts, hostId)).toBe(before);
      expect(hosts.list("on")[0]?.offline).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.live("goes offline as lost once it stops answering, without waiting for a redial", () =>
    Effect.gen(function* () {
      const { hosts, base } = yield* servedWith(undefined, { pingEveryMs: PING_EVERY_MS });
      const { hostId, dial } = yield* joinedAndConfirmed(hosts, base);
      const host = stallingHost(dial, hostId);
      yield* Effect.forkScoped(host.run);
      const connection = yield* online(hosts, hostId);
      host.stall(60_000);
      // Before, it stayed listed online, every call failing, until the machine dialled again.
      const offline = yield* Effect.gen(function* () {
        while (
          Effect.runSync(Effect.exit(hosts.connection(HostId.make(hostId))))._tag === "Success"
        )
          yield* Effect.sleep("50 millis");
      }).pipe(Effect.timeout("5 seconds"), Effect.exit);
      expect(offline._tag).toBe("Success");
      expect(connection.gone()).toBe(true);
      expect(hosts.list("on")[0]?.offline).toMatchObject({ kind: "lost" });
    }).pipe(Effect.scoped),
  );
});

describe("provisioned hosts' connections", () => {
  const HOSTS = "https://gram.internal:8443";

  /** The provisioned-host listener's route on loopback, answering as that listener would. */
  const servedProvisioned = (on: () => boolean) =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore(), Date.now, undefined, {
        provisionedOrigin: HOSTS,
      });
      const context = yield* Layer.build(
        HttpRouter.serve(
          HttpRouter.add(
            "*",
            "/host/*",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const named: HttpServerRequest.HttpServerRequest = Object.create(request, {
                headers: {
                  value: { ...request.headers, host: "gram.internal:8443" },
                },
              });
              return yield* provisionedRoute(hosts, authTarget(request.url)?.path, on(), () =>
                Effect.die(new Error("not in this test")),
              ).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, named));
            }),
          ),
          { disableListenLog: true, disableLogger: true },
        ).pipe(
          Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
        ),
      ).pipe(Effect.orDie);
      const port = serverPort(Context.get(context, HttpServer.HttpServer));
      const key = generateHostKey();
      const hostId = hostIdOf(key.publicKey);
      hosts.machines.provision({
        name: "sandbox",
        platform: "linux",
        publicKey: key.publicKey,
      });
      const dial: DialOptions = {
        origin: HOSTS,
        hostId,
        key: privateKeyFrom(key.privateKeyPem),
        url: `ws://127.0.0.1:${port}/host/connect`,
      };
      return { hosts, hostId, dial };
    });

  it.live(
    "stay through access over Tailscale turning off or moving, and end when they are turned off",
    () =>
      Effect.gen(function* () {
        let on = true;
        const { hosts, hostId, dial } = yield* servedProvisioned(() => on);
        yield* Effect.forkScoped(dialOnce(dial, service(hostId)));
        yield* online(hosts, hostId);
        expect(hosts.origin(HostId.make(hostId))).toBe(HOSTS);
        hosts.keepOrigin(undefined);
        hosts.keepOrigin(ORIGIN);
        hosts.keepOrigin("https://moved.example-tailnet.ts.net");
        yield* Effect.sleep("100 millis");
        expect(hosts.list("off")[0]).toHaveProperty("onlineSince");

        on = false;
        hosts.closeProvisioned();
        while (hosts.list()[0]?.onlineSince !== undefined) yield* Effect.sleep("20 millis");
        expect(hosts.list()[0]).toMatchObject({
          kind: "provisioned",
          offline: { kind: "lost" },
        });
        // Off, its dial is refused; on again, it is taken without registering anew.
        yield* dialOnce(dial, service(hostId));
        expect(hosts.list()[0]).not.toHaveProperty("onlineSince");
        on = true;
        yield* Effect.forkScoped(dialOnce(dial, service(hostId)));
        yield* online(hosts, hostId);
      }).pipe(Effect.scoped, Effect.timeout("15 seconds")),
  );

  it.live("are not taken when no address is kept for them", () =>
    Effect.gen(function* () {
      const hosts = yield* RemoteHosts.make(memoryMachineStore());
      const key = generateHostKey();
      const result = hosts.machines.provision({
        name: "sandbox",
        platform: "linux",
        publicKey: key.publicKey,
      });
      if (result.kind !== "provisioned") throw new Error("not provisioned");
      // A dial admitted for it (which the route never does without an address) doesn't attach.
      const closed = { ran: false };
      yield* hosts.attach(hosts.admit(result.machine, HOSTS), {
        get runRaw() {
          closed.ran = true;
          return () => Effect.void;
        },
      } as unknown as Socket.Socket);
      expect(closed.ran).toBe(false);
      expect(hosts.list()[0]).not.toHaveProperty("onlineSince");
    }).pipe(Effect.scoped),
  );
});

describe("a machine about to be taken away", () => {
  const IDLE = { turns: 0, terminals: 0, clones: 0, checks: 0 };
  const goingHost = Effect.gen(function* () {
    return stopOn({ proc: yield* Proc, busy: Effect.succeed(IDLE), admission: makeAdmission() });
  }).pipe(Effect.provide(ProcLive));

  it.live("is readied to stop as it says it goes, and goes once that is done", () =>
    Effect.gen(function* () {
      const { hosts, base } = yield* served;
      const { hostId, dial } = yield* joinedAndConfirmed(hosts, base);
      const stop = yield* goingHost;
      const heard: Array<{ id: string; withinMs: number }> = [];
      const release = yield* Deferred.make<void>();
      hosts.onGoing((id, withinMs) =>
        Effect.gen(function* () {
          heard.push({ id, withinMs });
          const connection = yield* hosts.connection(id);
          yield* connection.stop.prepare({ checkouts: [], force: true });
          yield* Deferred.await(release);
        }).pipe(Effect.orDie),
      );
      yield* Effect.forkScoped(
        dialOnce(dial, service(hostId, { features: ["stop-going"] }, { stop })),
      );
      const connection = yield* online(hosts, hostId);
      expect(connection.stop.going).toBeDefined();
      // Its listener is on before anything is said.
      yield* Effect.sleep("100 millis");
      let gone = false;
      const going = yield* Effect.forkScoped(
        stop.goAway(10_000).pipe(Effect.tap(() => Effect.sync(() => (gone = true)))),
      );
      yield* waitUntil("the machine to be heard", () => heard.length === 1);
      expect(heard).toEqual([{ id: hostId, withinMs: 10_000 }]);
      // Held while the control plane is still readying it.
      yield* waitUntil("the stop to be readied", () => stop.stopping());
      yield* Effect.sleep("100 millis");
      expect(gone).toBe(false);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(going)).toBe("stopped");
    }).pipe(Effect.scoped, Effect.timeout("15 seconds")),
  );

  it.live("goes at once when nothing listens, and when its listener's connection drops", () =>
    Effect.gen(function* () {
      expect(yield* (yield* goingHost).goAway(10_000)).toBe("unheard");

      const { hosts, base } = yield* served;
      const { hostId, dial } = yield* joinedAndConfirmed(hosts, base);
      const stop = yield* goingHost;
      let heard = 0;
      // Hears it, and never lets go.
      hosts.onGoing(() =>
        Effect.sync(() => {
          heard += 1;
        }).pipe(Effect.andThen(Effect.never)),
      );
      yield* Effect.forkScoped(
        dialOnce(dial, service(hostId, { features: ["stop-going"] }, { stop })),
      );
      yield* online(hosts, hostId);
      yield* Effect.sleep("100 millis");
      const going = yield* Effect.forkScoped(stop.goAway(10_000));
      yield* waitUntil("the machine to be heard", () => heard === 1);
      hosts.keepOrigin(undefined);
      expect(yield* Fiber.join(going)).toBe("unheard");
    }).pipe(Effect.scoped, Effect.timeout("15 seconds")),
  );

  it.live("goes once its time is up, whoever still listens", () =>
    Effect.gen(function* () {
      const { hosts, base } = yield* served;
      const { hostId, dial } = yield* joinedAndConfirmed(hosts, base);
      const stop = yield* goingHost;
      hosts.onGoing(() => Effect.never);
      yield* Effect.forkScoped(
        dialOnce(dial, service(hostId, { features: ["stop-going"] }, { stop })),
      );
      yield* online(hosts, hostId);
      yield* Effect.sleep("100 millis");
      expect(yield* stop.goAway(300)).toBe("late");
    }).pipe(Effect.scoped, Effect.timeout("15 seconds")),
  );
});

/** Stop marks kept in memory, as a restart of this Gram would find them. */
const memoryMarks = () => {
  let kept: MachineMarksByHost = {};
  return {
    read: () => ({ machines: kept, dropped: 0 }),
    write: (all: MachineMarksByHost) => {
      kept = structuredClone(all);
    },
  } satisfies MarksStore;
};

/** Dials until the host is online, then drops it and waits until it is offline again. */
const dialAndDrop = (
  hosts: RemoteHosts["Service"],
  hostId: string,
  dial: DialOptions,
  said: Partial<HostService["hello"]>,
) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkScoped(dialOnce(dial, service(hostId, said)));
    yield* online(hosts, hostId);
    yield* Fiber.interrupt(fiber);
    while (hosts.origin(HostId.make(hostId)) !== undefined) yield* Effect.sleep("20 millis");
  });

describe("the disk a joined machine's host says it is on", () => {
  const diskA = { diskId: "disk-aaaaaaaa", bootId: "boot-aaaaaaaa" };
  const diskB = { diskId: "disk-bbbbbbbb", bootId: "boot-bbbbbbbb" };

  it.live("a host that says no disk never takes the machine from one that says its own", () =>
    Effect.gen(function* () {
      const { hosts, base } = yield* servedWith(undefined, { marks: memoryMarks() });
      const { hostId, dial } = yield* joinedAndConfirmed(hosts, base);
      yield* dialAndDrop(hosts, hostId, dial, diskA);
      // Back on another disk: owed a resume before any session opens there.
      const replacement = yield* Effect.forkScoped(dialOnce(dial, service(hostId, diskB)));
      expect((yield* online(hosts, hostId)).hello.diskId).toBe(diskB.diskId);
      expect(hosts.stops.resuming(hostId)).toBe(true);
      // An older host, or one that couldn't keep its id, dials in: it can't say it isn't the old
      // disk's, so the replacement stays, and still owes its resume.
      yield* dialOnce(dial, service(hostId)).pipe(Effect.timeout("10 seconds"));
      expect((yield* hosts.connection(hostId)).hello.diskId).toBe(diskB.diskId);
      expect(hosts.stops.resuming(hostId)).toBe(true);
      // Nor does it take the machine while that resume is owed, with the replacement gone.
      yield* Fiber.interrupt(replacement);
      while (hosts.origin(hostId) !== undefined) yield* Effect.sleep("20 millis");
      yield* dialOnce(dial, service(hostId)).pipe(Effect.timeout("10 seconds"));
      expect(hosts.origin(hostId)).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.live("a machine whose hosts never said a disk comes online as before", () =>
    Effect.gen(function* () {
      const { hosts, base } = yield* servedWith(undefined, { marks: memoryMarks() });
      const { hostId, dial } = yield* joinedAndConfirmed(hosts, base);
      yield* dialAndDrop(hosts, hostId, dial, {});
      const fiber = yield* Effect.forkScoped(dialOnce(dial, service(hostId)));
      yield* online(hosts, hostId);
      expect(hosts.stops.resuming(hostId)).toBe(false);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );

  it.live("remembers across a restart which disk a machine is on, and what it owes", () =>
    Effect.gen(function* () {
      const marks = memoryMarks();
      const before = yield* servedWith(undefined, { marks });
      const { hostId, dial } = yield* joinedAndConfirmed(before.hosts, before.base);
      const machine = before.hosts.machines.get(hostId)!;
      yield* dialAndDrop(before.hosts, hostId, dial, diskA);
      yield* dialAndDrop(before.hosts, hostId, dial, diskB);
      // This Gram restarts: a new registry over what was kept.
      const after = yield* RemoteHosts.make(memoryMachineStore([machine]), undefined, undefined, {
        marks,
      });
      expect(after.stops.resuming(hostId)).toBe(true);
      expect(after.stops.disk(hostId)).toBe(diskB.diskId);
      expect(after.stops.hello(hostId, { ...diskB, bootId: "boot-cccccccc" })).toEqual({
        kind: "restarted",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("starts over, rather than not at all, when the kept marks can't be read", () =>
    Effect.gen(function* () {
      const written: Array<MachineMarksByHost> = [];
      const hosts = yield* RemoteHosts.make(memoryMachineStore(), undefined, undefined, {
        marks: {
          read: () => {
            throw new Error("machine-marks.json isn't a machine marks file.");
          },
          write: (all) => void written.push(all),
        },
      });
      const id = HostId.make("m-one");
      expect(hosts.stops.resuming(id)).toBe(false);
      hosts.stops.expect(id);
      expect(Object.keys(written.at(-1) ?? {})).toEqual(["m-one"]);
    }),
  );
});
