import { createServer } from "node:http";
import { describe, expect, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { HOST_PROTOCOL_VERSION, HostId } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { authTarget } from "../http/auth-target.ts";
import { hostRoute } from "../http/machine-routes.ts";
import type { RemoteAccess } from "../http/remote-access.ts";
import { serverPort } from "../http/server.ts";
import { HttpRouter, HttpServer, HttpServerRequest } from "../platform/unstable.ts";
import { dialOnce } from "./dial.ts";
import { generateHostKey, hostIdOf, privateKeyFrom } from "./machine-keys.ts";
import { memoryMachineStore } from "./paired-machines.ts";
import { HOST_CAPABILITIES, type HostService } from "./protocol.ts";
import { RemoteHosts } from "./remote-hosts.ts";
import { noAgents, sessionsOnHost } from "./sessions.ts";
import { terminalsOnHost } from "./terminals.ts";

const ORIGIN = "https://main.example-tailnet.ts.net";

const none = () => Effect.die(new Error("not in this test"));

/** A host that says hello as `hostId` and has nothing else a test reaches. */
const service = (hostId: string): Effect.Effect<HostService, never, Scope.Scope> =>
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
    } as unknown as HostService;
  });

/** The machines' two routes on loopback, answering as if over the tailnet address. */
const served = Effect.gen(function* () {
  const hosts = yield* RemoteHosts.make(memoryMachineStore());
  const context = yield* Layer.build(
    HttpRouter.serve(
      HttpRouter.add(
        "*",
        "/host/*",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const remote = { host: request.headers["host"], origin: ORIGIN } as RemoteAccess;
          return yield* hostRoute(hosts, remote, authTarget(request.url)?.path ?? "");
        }),
      ),
      { disableListenLog: true, disableLogger: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  ).pipe(Effect.orDie);
  const port = serverPort(Context.get(context, HttpServer.HttpServer));
  return { hosts, port, base: `http://127.0.0.1:${port}` };
});

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
});
