// Acceptance for provisioned hosts: the real server with its TLS listener, and the real
// `gram-host` as its own process. A host whose key was registered connects over TLS with no
// Tailscale and no confirm step; one whose key wasn't is refused.

import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, type KeyObject, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it as test, layer } from "@effect/vitest";
import { applySettingsPatch } from "@gram/contracts";
import { captureLogs } from "@gram/agents/testing/logs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ServerConfig } from "../config.ts";
import { gitPlatformTest } from "../git/platform.ts";
import {
  HOST_CONNECT_PATH,
  HOST_MCP_PATH,
  hostIdOf,
  privateKeyFrom,
  publicKeyText,
  signedConnectHeaders,
} from "../host/machine-keys.ts";
import { readHostKey } from "../host/host-config.ts";
import type { ProvisionedHost } from "../host/cli.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { HttpServer } from "../platform/unstable.ts";
import { FakeAgentAdapter } from "../runtime/fake-agent.ts";
import { TurnHooks } from "../runtime/hooks.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { tokenCookieName } from "./auth.ts";
import {
  MACHINES_LIST_PATH,
  MACHINES_PROVISION_PATH,
  MACHINES_REMOVE_PATH,
} from "./machine-routes.ts";
import { IDENTITY_HEADER, SERVICE_TYP, type FrontedIdentityConfig } from "./fronted-identity.ts";
import { makeTestProxy } from "./fronted-identity.testing.ts";
import { MACHINES_STOP_STATUS_PATH } from "./host-stop-routes.ts";
import { ProvisionedListener } from "./provisioned-listener.ts";
import { LaunchToken, SERVICE_PATHS, serverPort, ServerLayer } from "./server.ts";

const temp = mkdtempSync(join(tmpdir(), "gram-provisioned-"));
afterAll(() =>
  rmSync(temp, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  }),
);

/** A port nothing listens on now, for an origin that has to name its port before the server binds. */
const unusedPort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        resolve(typeof address === "object" && address !== null ? address.port : 0),
      );
    });
  });
const freePort = await unusedPort();
const ORIGIN = `https://localhost:${freePort}`;
const HOST = `localhost:${freePort}`;

// A synthetic certificate for `localhost`, its own authority, made for this run alone.
const certFile = join(temp, "cert.pem");
const keyFile = join(temp, "key.pem");
writeFileSync(
  join(temp, "openssl.cnf"),
  [
    "[req]",
    "distinguished_name = dn",
    "x509_extensions = v3",
    "prompt = no",
    "[dn]",
    "CN = localhost",
    "[v3]",
    "subjectAltName = DNS:localhost, IP:127.0.0.1",
    "basicConstraints = critical, CA:TRUE",
    "",
  ].join("\n"),
);
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-keyout",
    keyFile,
    "-out",
    certFile,
    "-config",
    join(temp, "openssl.cnf"),
  ],
  { stdio: "ignore" },
);
const ca = readFileSync(certFile);

const serverWith = (dataDir: string, port: number, fronted?: FrontedIdentityConfig) =>
  ServerLayer.pipe(
    Layer.provide(FakeAgentAdapter),
    Layer.provide(TurnHooks.layerNoop),
    Layer.provide(gitPlatformTest()),
    Layer.provide(
      ServerConfig.layer({
        ...TEST_CONFIG,
        dataDir,
        provisionedHosts: {
          origin: `https://localhost:${port}`,
          port,
          listenHost: "127.0.0.1",
          certFile,
          keyFile,
        },
        ...(fronted === undefined ? {} : { frontedIdentity: fronted, embedding: true }),
      }),
    ),
    Layer.orDie,
    Layer.provideMerge(captureLogs({ printWarnings: true }).layer),
  );
const TestServer = serverWith(join(temp, "data"), freePort);

interface Answer {
  readonly status: number;
  readonly body: string;
}

/** One request to the app's own loopback listener, as the local app makes it. */
const local = (path: string, body?: unknown) =>
  Effect.gen(function* () {
    const port = serverPort(yield* HttpServer.HttpServer);
    const { token } = yield* LaunchToken;
    return yield* Effect.promise(
      () =>
        new Promise<Answer>((resolve, reject) => {
          const text = body === undefined ? "" : JSON.stringify(body);
          const req = httpRequest(
            {
              host: "127.0.0.1",
              port,
              path,
              method: "POST",
              agent: false,
              headers: {
                cookie: `${tokenCookieName(port)}=${token}`,
                origin: `http://127.0.0.1:${port}`,
                "content-type": "application/json",
                "content-length": Buffer.byteLength(text),
              },
            },
            (res) => {
              let answer = "";
              res.setEncoding("utf8");
              res.on("data", (chunk: string) => (answer += chunk));
              res.on("end", () => resolve({ status: res.statusCode ?? 0, body: answer }));
            },
          );
          req.on("error", reject);
          req.end(text);
        }),
    );
  });

/** One request to the provisioned-host listener over TLS; 101 when a WebSocket upgrade is taken. */
const overTls = (options: {
  readonly path: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly upgrade?: boolean;
}) =>
  Effect.promise(
    () =>
      new Promise<Answer>((resolve, reject) => {
        const req = httpsRequest({
          host: "127.0.0.1",
          servername: "localhost",
          port: freePort,
          ca,
          path: options.path,
          method: options.method ?? "GET",
          agent: false,
          headers: {
            host: HOST,
            ...(options.upgrade === true
              ? {
                  connection: "Upgrade",
                  upgrade: "websocket",
                  "sec-websocket-version": "13",
                  "sec-websocket-key": randomBytes(16).toString("base64"),
                }
              : {}),
            ...options.headers,
          },
        });
        req.on("upgrade", (_res, socket) => {
          socket.destroy();
          resolve({ status: 101, body: "" });
        });
        req.on("response", (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.end();
      }),
  );

/** A dial of `/host/connect` signed by `key`, as gram-host sends it. */
const dial = (
  key: { readonly privateKey: KeyObject; readonly publicKey: KeyObject },
  origin = ORIGIN,
  headers: Record<string, string> = {},
) =>
  overTls({
    path: HOST_CONNECT_PATH,
    upgrade: true,
    headers: {
      ...signedConnectHeaders(key.privateKey, origin, hostIdOf(publicKeyText(key.publicKey))),
      ...headers,
    },
  });

const HOST_ENTRY = fileURLToPath(new URL("../host/main.ts", import.meta.url));
/** What gram-host runs with: its own folder, the fake agent, and the test certificate trusted. */
const hostEnv = (home: string) => ({
  ...process.env,
  GRAM_HOST_HOME: home,
  GRAM_FAKE_AGENT: "1",
  NODE_EXTRA_CA_CERTS: certFile,
});

/** `gram-host provision` in a folder of its own: the key it made, as a control plane reads it. */
const provisionHost = (name: string): ProvisionedHost & { readonly home: string } => {
  const home = join(temp, `host-${name}`);
  const printed = execFileSync(
    process.execPath,
    [HOST_ENTRY, "provision", "--origin", ORIGIN, "--name", name],
    { env: hostEnv(home), encoding: "utf8" },
  );
  return { ...(JSON.parse(printed) as ProvisionedHost), home };
};

/** `gram-host run` as its own process, stopped with the scope. */
const runHost = (home: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      let output = "";
      const child = spawn(process.execPath, [HOST_ENTRY, "run"], {
        env: hostEnv(home),
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      return { child, output: () => output };
    }),
    ({ child }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once("exit", () => resolve());
            child.kill("SIGKILL");
          }),
      ),
  );

interface Listed {
  readonly id: string;
  readonly name: string;
  readonly kind?: string;
  readonly confirmed: boolean;
  readonly onlineSince?: number;
}
const machines = Effect.map(
  local(MACHINES_LIST_PATH),
  (answer) => (JSON.parse(answer.body) as { machines: Listed[] }).machines,
);
const machine = (id: string) =>
  Effect.map(machines, (listed) => listed.find((one) => one.id === id));

/** Waits until `check` holds, looking every 100 ms for up to `seconds`. */
const until = <A, E, R>(
  check: Effect.Effect<A | undefined | false, E, R>,
  seconds: number,
  what: string,
) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < seconds * 10; tries++) {
      const found = yield* check;
      if (found !== undefined && found !== false) return found;
      yield* Effect.sleep("100 millis");
    }
    throw new Error(`Timed out waiting for ${what}`);
  });

const hostedFeatures = (embedding: boolean) =>
  Effect.gen(function* () {
    yield* (yield* ThreadStore).updateSettings(
      (settings) => applySettingsPatch(settings, { experimental: { embedding } }),
      [["experimental", "embedding"]],
    );
  });

/** Whether anything listens on the provisioned-host port now. */
const listening = Effect.promise(
  () =>
    new Promise<boolean>((resolve) => {
      const socket = connect(freePort, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    }),
);

/** One request to the app's loopback listener claiming the provisioned-host name. */
const loopbackAs = (headers: Record<string, string>) =>
  Effect.gen(function* () {
    const port = serverPort(yield* HttpServer.HttpServer);
    return yield* Effect.promise(
      () =>
        new Promise<number>((resolve, reject) => {
          const req = httpRequest({
            host: "127.0.0.1",
            port,
            path: HOST_CONNECT_PATH,
            agent: false,
            headers: {
              connection: "Upgrade",
              upgrade: "websocket",
              "sec-websocket-version": "13",
              "sec-websocket-key": randomBytes(16).toString("base64"),
              ...headers,
            },
          });
          req.on("upgrade", (_res, socket) => {
            socket.destroy();
            resolve(101);
          });
          req.on("response", (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on("error", reject);
          req.end();
        }),
    );
  });

/** A file of the server's machine storage, as text. */
const kept = (name: string) => readFileSync(join(temp, "data", "remote-access", name), "utf8");

const register = (name: string, publicKey: string) =>
  local(MACHINES_PROVISION_PATH, { name, publicKey, platform: process.platform });

layer(TestServer, { excludeTestServices: true })("provisioned hosts over TLS", (it) => {
  it.effect(
    "with hosted features off, nothing listens, and nothing can be registered",
    () =>
      Effect.gen(function* () {
        const host = provisionHost("off");
        const refused = yield* register(host.name, host.publicKey);
        expect(refused.status).toBe(409);
        expect(yield* machines).toEqual([]);
        // Long enough for the listener to have opened, were it going to.
        yield* Effect.sleep("4 seconds");
        expect(yield* listening).toBe(false);
      }),
    60_000,
  );

  it.effect(
    "a host with a registered key connects over TLS, and one with an unknown key is refused",
    () =>
      Effect.gen(function* () {
        yield* hostedFeatures(true);
        yield* until(listening, 15, "the listener to open once hosted features are on");

        // The host makes its key; the control plane registers the public half. No join link, no
        // Tailscale, and nothing to confirm.
        const registered = provisionHost("sandbox-1");
        const answer = yield* register(registered.name, registered.publicKey);
        expect(answer.status).toBe(200);
        expect(JSON.parse(answer.body)).toEqual({
          hostId: registered.hostId,
          fingerprint: registered.fingerprint,
          created: true,
          origin: ORIGIN,
        });
        // The same registration again changes nothing; its name is taken for any other key.
        expect(
          JSON.parse((yield* register(registered.name, registered.publicKey)).body),
        ).toMatchObject({ hostId: registered.hostId, created: false });
        // It is kept apart from the machines a person joined.
        expect(kept("provisioned-hosts.json")).toContain(registered.hostId);
        expect(kept("machines.json")).not.toContain(registered.hostId);

        // A second host made its key the same way, but nobody registered it.
        const unknown = provisionHost("stranger");
        expect((yield* register(registered.name, unknown.publicKey)).status).toBe(409);

        const running = yield* runHost(registered.home);
        const stranger = yield* runHost(unknown.home);

        const online = yield* until(
          Effect.map(machine(registered.hostId), (one) =>
            one?.onlineSince === undefined ? undefined : one,
          ),
          45,
          "the registered host to come online",
        ).pipe(
          Effect.catchDefect((defect) =>
            Effect.die(new Error(`${String(defect)}\ngram-host said:\n${running.output()}`)),
          ),
        );
        expect(online).toMatchObject({ name: "sandbox-1", kind: "provisioned", confirmed: true });

        // The unregistered host's own key, used exactly as its process uses it, is refused on the
        // wire with 401 before any WebSocket opens; its process is left dialling, never listed.
        const strangerKey = { privateKey: privateKeyFrom(readHostKey(unknown.home)!) };
        const dialAs = (
          key: { readonly privateKey: KeyObject },
          hostId: string,
          origin = ORIGIN,
          extra: Record<string, string> = {},
        ) => ({
          path: HOST_CONNECT_PATH,
          upgrade: true,
          headers: { ...signedConnectHeaders(key.privateKey, origin, hostId), ...extra },
        });
        const refused = yield* overTls(dialAs(strangerKey, unknown.hostId));
        expect(refused).toEqual({ status: 401, body: "unauthorized: machine not joined" });
        yield* until(
          Effect.sync(() => /not connected; dialling again/.test(stranger.output())),
          30,
          "the unregistered host to be left dialling",
        );
        expect(yield* machine(unknown.hostId)).toBeUndefined();
        expect((yield* machines).map((one) => one.id)).toEqual([registered.hostId]);

        // Other keys nobody registered: a fresh one, an unsigned dial, and one naming the
        // registered host without its key.
        const outsider = generateKeyPairSync("ed25519");
        expect((yield* dial(outsider)).status).toBe(401);
        expect((yield* overTls({ path: HOST_CONNECT_PATH, upgrade: true })).status).toBe(401);
        expect((yield* overTls(dialAs(outsider, registered.hostId))).status).toBe(401);

        // A registered key of this test's own, to dial with by hand.
        const probe = generateKeyPairSync("ed25519");
        const probeId = hostIdOf(publicKeyText(probe.publicKey));
        expect((yield* register("probe", publicKeyText(probe.publicKey))).status).toBe(200);
        // Signed for another address than the listener's.
        expect(yield* overTls(dialAs(probe, probeId, "https://elsewhere.internal"))).toEqual({
          status: 401,
          body: "unauthorized: bad signature",
        });
        // A dial that asks for no WebSocket connects nothing and spends nothing: the same
        // headers are then taken once, and never again.
        const once = dialAs(probe, probeId);
        expect((yield* overTls({ ...once, upgrade: false })).status).toBe(400);
        expect((yield* overTls(once)).status).toBe(101);
        expect(yield* overTls(once)).toEqual({ status: 401, body: "unauthorized: dial replayed" });

        // The listener serves hosts and nothing else: not the app, its socket, its settings
        // routes, a join or the installer, and not under another name or from a browser.
        for (const path of ["/", "/ws", "/mcp", MACHINES_LIST_PATH, "/host/join", "/host/install"])
          expect((yield* overTls({ path })).status, path).toBe(403);
        for (const path of ["/ws", "/host/connect/", "//host/connect", "/HOST/CONNECT"])
          expect((yield* overTls({ ...dialAs(probe, probeId), path })).status, path).toBe(403);
        expect((yield* overTls({ path: MACHINES_PROVISION_PATH, method: "POST" })).status).toBe(
          403,
        );
        expect((yield* overTls(dialAs(probe, probeId, ORIGIN, { host: "127.0.0.1" }))).status).toBe(
          403,
        );
        expect((yield* overTls(dialAs(probe, probeId, ORIGIN, { origin: ORIGIN }))).status).toBe(
          403,
        );
        // Its app-tools endpoint takes a placed thread's token, not just any request.
        expect((yield* overTls({ path: HOST_MCP_PATH, method: "POST" })).status).toBe(401);
        // The app's own listener takes no host's dial, under the listener's name or its own.
        for (const host of [HOST, "127.0.0.1"])
          expect(
            yield* loopbackAs({ ...signedConnectHeaders(probe.privateKey, ORIGIN, probeId), host }),
          ).not.toBe(101);

        // Turning hosted features off closes the listener and drops the host; on again, it is
        // back without registering anew.
        yield* hostedFeatures(false);
        yield* until(
          Effect.map(machine(registered.hostId), (one) => one?.onlineSince === undefined),
          15,
          "the host to be dropped when hosted features go off",
        );
        yield* until(
          Effect.map(listening, (open) => !open),
          15,
          "the listener to close when hosted features go off",
        );
        expect((yield* register("late", publicKeyText(outsider.publicKey))).status).toBe(409);
        yield* hostedFeatures(true);
        yield* until(
          Effect.map(machine(registered.hostId), (one) => one?.onlineSince !== undefined),
          45,
          "the host to come back",
        );

        // Removed, its key is unknown again.
        const registeredKey = { privateKey: privateKeyFrom(readHostKey(registered.home)!) };
        expect((yield* local(MACHINES_REMOVE_PATH, { id: registered.hostId })).status).toBe(200);
        expect(yield* overTls(dialAs(registeredKey, registered.hostId))).toEqual({
          status: 401,
          body: "unauthorized: machine not joined",
        });
        expect((yield* machines).map((one) => one.id)).toEqual([probeId]);

        // A host for the threads placed on it by name (one run's, say) needs no owner; a person's
        // own host does, and an owner always comes with a kind.
        const forRun = provisionHost("run-1");
        const run = (body: Record<string, unknown>) =>
          local(MACHINES_PROVISION_PATH, {
            name: forRun.name,
            publicKey: forRun.publicKey,
            platform: process.platform,
            ...body,
          });
        expect((yield* run({ onDemand: "personal" })).status).toBe(400);
        expect((yield* run({ owner: "ada" })).status).toBe(400);
        expect((yield* run({ onDemand: "elsewhere" })).status).toBe(400);
        expect((yield* run({ onDemand: "thread" })).status).toBe(200);
        const stored = JSON.parse(kept("provisioned-hosts.json")) as {
          machines: Array<{ name: string; onDemand?: string; owner?: string }>;
        };
        const runsOwn = stored.machines.find((each) => each.name === forRun.name);
        expect(runsOwn?.onDemand).toBe("thread");
        expect(runsOwn?.owner).toBeUndefined();
      }).pipe(Effect.scoped),
    180_000,
  );
});

test("stops in order with a connection that never finishes its request, and when its port is taken", async () => {
  const port = await unusedPort();
  // Something else has the port at first: the server runs all the same, and takes it once free.
  const squatter = createServer();
  await new Promise<void>((resolve) => squatter.listen(port, "127.0.0.1", resolve));
  const tcp = (open: boolean) =>
    new Promise<boolean>((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(open);
      });
      socket.once("error", () => resolve(!open));
    });
  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(serverWith(join(temp, "data-stop"), port), scope);
      yield* hostedFeatures(true).pipe(Effect.provideContext(context));
      const listener = Context.get(context, ProvisionedListener);
      yield* Effect.sleep("4 seconds");
      expect(listener.port()).toBeUndefined();
      yield* Effect.promise(() => new Promise<void>((resolve) => squatter.close(() => resolve())));
      yield* until(
        Effect.sync(() => listener.port() === port),
        30,
        "the listener to take its port once it is free",
      );

      // A TLS connection that sends half a request and waits: Node's own close would wait on it.
      const half = yield* Effect.promise(
        () =>
          new Promise<TLSSocket>((resolve, reject) => {
            const socket = tlsConnect(
              { host: "127.0.0.1", port, ca, servername: "localhost" },
              () =>
                socket.write("GET /host/connect HTTP/1.1\r\nHost: localhost\r\n", () =>
                  resolve(socket),
                ),
            );
            socket.once("error", reject);
          }),
      );
      const ended = new Promise<void>((resolve) => half.once("close", () => resolve()));
      half.on("error", () => {});
      const started = Date.now();
      yield* Scope.close(scope, Exit.void);
      expect(Date.now() - started).toBeLessThan(8_000);
      yield* Effect.promise(() => ended);
      expect(yield* Effect.promise(() => tcp(false))).toBe(true);
    }),
  );
}, 90_000);

const proxy = makeTestProxy();
const frontedPort = await unusedPort();

/** One request as the fronting proxy forwards it, carrying the statement it signed. */
const fronted = (
  claims: Record<string, unknown>,
  path: string,
  body: unknown = {},
  header: Record<string, unknown> = {},
) =>
  Effect.gen(function* () {
    const port = serverPort(yield* HttpServer.HttpServer);
    return yield* Effect.promise(
      () =>
        new Promise<Answer>((resolve, reject) => {
          const text = JSON.stringify(body);
          const req = httpRequest(
            {
              host: "127.0.0.1",
              port,
              path,
              method: "POST",
              agent: false,
              headers: {
                [IDENTITY_HEADER]: proxy.statement(claims, { header }),
                origin: proxy.config.origin,
                "content-type": "application/json",
                "content-length": Buffer.byteLength(text),
              },
            },
            (res) => {
              let answer = "";
              res.setEncoding("utf8");
              res.on("data", (chunk: string) => (answer += chunk));
              res.on("end", () => resolve({ status: res.statusCode ?? 0, body: answer }));
            },
          );
          req.on("error", reject);
          req.end(text);
        }),
    );
  });

layer(serverWith(join(temp, "data-fronted"), frontedPort, proxy.config), {
  excludeTestServices: true,
})("provisioned hosts behind a fronting proxy", (it) => {
  it.effect(
    "the platform's own statement registers and removes a host, and a person's never does",
    () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const service = { sub: "platform", name: "Platform", role: "service" };
        /** The platform's own statement, made for the path it calls. */
        const platform = (path: string, body?: unknown, madeFor = path) =>
          fronted({ ...service, path: madeFor }, path, body, { typ: SERVICE_TYP });
        const publicKey = publicKeyText(generateKeyPairSync("ed25519").publicKey);
        const hostId = hostIdOf(publicKey);
        const host = { name: "sandbox-1", publicKey, platform: "linux" };

        // Whoever signed in through the proxy, whatever their role, is no platform.
        for (const role of ["member", "viewer"])
          for (const path of SERVICE_PATHS)
            expect((yield* fronted({ role }, path, host)).status).toBe(403);
        // A role a proxy copied from a directory is not the platform's statement either.
        expect(
          (yield* fronted(
            { ...service, path: MACHINES_PROVISION_PATH },
            MACHINES_PROVISION_PATH,
            host,
          )).status,
        ).toBe(401);
        // And one made for another path, seen on its way, registers nothing.
        expect((yield* platform(MACHINES_PROVISION_PATH, host, MACHINES_LIST_PATH)).status).toBe(
          403,
        );
        // Nor is the local app's launch cookie, from its own origin.
        expect((yield* local(MACHINES_PROVISION_PATH, host)).status).toBe(403);

        const registered = yield* platform(MACHINES_PROVISION_PATH, host);
        expect(registered.status).toBe(200);
        expect(JSON.parse(registered.body)).toMatchObject({
          hostId,
          created: true,
          origin: `https://localhost:${frontedPort}`,
        });
        const listed = () =>
          Effect.map(platform(MACHINES_LIST_PATH), (answer) =>
            (JSON.parse(answer.body) as { machines: ReadonlyArray<{ id: string }> }).machines.map(
              (one) => one.id,
            ),
          );
        expect(yield* listed()).toEqual([hostId]);
        expect((yield* platform(MACHINES_REMOVE_PATH, { id: hostId })).status).toBe(200);
        expect(yield* listed()).toEqual([]);

        // It asks which machines are readied to stop, as it would before stopping one.
        expect((yield* platform(MACHINES_STOP_STATUS_PATH)).status).toBe(200);

        // The platform's statement opens nothing else: no page, no socket's path, no other
        // machine route, and none of what people reach.
        for (const path of ["/", "/ws", "/machines/join-link", "/remote/status", "/mcp"])
          expect((yield* platform(path)).status).toBe(403);

        // Each of its calls is on record as the platform's, with how it was answered.
        expect(
          (yield* store.listActorEvents()).map(({ actor, action, data }) => [
            actor.id,
            actor.role,
            action,
            data["status"],
          ]),
        ).toEqual([
          ["platform", "service", MACHINES_PROVISION_PATH, 200],
          ["platform", "service", MACHINES_LIST_PATH, 200],
          ["platform", "service", MACHINES_REMOVE_PATH, 200],
          ["platform", "service", MACHINES_LIST_PATH, 200],
          ["platform", "service", MACHINES_STOP_STATUS_PATH, 200],
        ]);
      }),
    60_000,
  );
});
