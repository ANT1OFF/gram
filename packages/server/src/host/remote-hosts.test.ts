import { createServer } from "node:http";
import { describe, expect, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { HOST_PROTOCOL_VERSION, HostId } from "@gram/contracts";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { authTarget } from "../http/auth-target.ts";
import { hostRoute } from "../http/machine-routes.ts";
import type { RemoteAccess } from "../http/remote-access.ts";
import { serverPort } from "../http/server.ts";
import { HttpRouter, HttpServer, HttpServerRequest, Socket } from "../platform/unstable.ts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { type DialOptions, dialOnce } from "./dial.ts";
import { generateHostKey, hostIdOf, privateKeyFrom, signedConnectHeaders } from "./machine-keys.ts";
import { memoryMachineStore } from "./paired-machines.ts";
import { HOST_CAPABILITIES, type HostService, serveHost } from "./protocol.ts";
import { RemoteHosts } from "./remote-hosts.ts";
import { noAgents, sessionsOnHost } from "./sessions.ts";
import { terminalsOnHost } from "./terminals.ts";

const ORIGIN = "https://main.example-tailnet.ts.net";

const none = () => Effect.die(new Error("not in this test"));

/** A host that says hello as `hostId` and has nothing else a test reaches. */
const service = (
  hostId: string,
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
const servedWith = (duringUpgrade?: (hosts: RemoteHosts["Service"]) => void) =>
  Effect.gen(function* () {
    const hosts = yield* RemoteHosts.make(memoryMachineStore());
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

/** A host that holds back its hello by `delay`. */
const slowHello = (dial: DialOptions, hostId: string, delay: Duration.Input) =>
  Effect.gen(function* () {
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
          return Effect.andThen(Effect.sleep(delay), reader.pull);
        }),
      })),
    };
    yield* serveHost(held, yield* service(hostId));
  }).pipe(Effect.scoped, Effect.provide(NodeSocket.layerWebSocketConstructor));

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

  it.live(
    "keeps a machine removed while it says hello offline",
    () =>
      Effect.gen(function* () {
        const { hosts, base } = yield* served;
        const { hostId, dial } = yield* joinedAndConfirmed(hosts, base);
        yield* Effect.forkScoped(slowHello(dial, hostId, "3 seconds"));
        yield* Effect.sleep("1 second");
        hosts.remove(HostId.make(hostId));
        yield* Effect.sleep("4 seconds");
        expect(hosts.list()).toEqual([]);
        expect(Effect.runSync(Effect.exit(hosts.connection(HostId.make(hostId))))._tag).toBe(
          "Failure",
        );
      }).pipe(Effect.scoped),
    20_000,
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
      yield* Effect.forkScoped(dialOnce(dial, service(hostId, { status })));
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
        yield* Effect.forkScoped(slowHello(dial, hostId, "4 seconds"));
        yield* Effect.sleep("1 second");
        expect(finished()).toBe(0);
        hosts.keepOrigin(undefined);
        // Ended at once, not when the held hello arrives three seconds later.
        yield* Effect.sleep("1 second");
        expect(finished()).toBe(1);
        yield* Effect.sleep("3 seconds");
        expect(hosts.list()[0]).not.toHaveProperty("onlineSince");
      }).pipe(Effect.scoped),
    20_000,
  );
});
