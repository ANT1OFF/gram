// Acceptance for provisioned hosts: the real server with its TLS listener, and the real
// `gram-host` as its own process. A host whose key was registered connects over TLS with no
// Tailscale and no confirm step; one whose key wasn't is refused.

import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, type KeyObject, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, layer } from "@effect/vitest";
import { applySettingsPatch } from "@gram/contracts";
import { captureLogs } from "@gram/agents/testing/logs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import { gitPlatformTest } from "../git/platform.ts";
import {
  HOST_CONNECT_PATH,
  HOST_MCP_PATH,
  hostIdOf,
  publicKeyText,
  signedConnectHeaders,
} from "../host/machine-keys.ts";
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
import { LaunchToken, serverPort, ServerLayer } from "./server.ts";

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
const freePort = await new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
  });
});
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

const TestServer = ServerLayer.pipe(
  Layer.provide(FakeAgentAdapter),
  Layer.provide(TurnHooks.layerNoop),
  Layer.provide(gitPlatformTest()),
  Layer.provide(
    ServerConfig.layer({
      ...TEST_CONFIG,
      dataDir: join(temp, "data"),
      provisionedHosts: {
        origin: ORIGIN,
        port: freePort,
        listenHost: "127.0.0.1",
        certFile,
        keyFile,
      },
    }),
  ),
  Layer.orDie,
  Layer.provideMerge(captureLogs({ printWarnings: true }).layer),
);

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

layer(TestServer, { excludeTestServices: true })("provisioned hosts over TLS", (it) => {
  it.effect(
    "with hosted features off, nothing can be registered and no dial is taken",
    () =>
      Effect.gen(function* () {
        const host = provisionHost("off");
        const refused = yield* local(MACHINES_PROVISION_PATH, {
          name: host.name,
          publicKey: host.publicKey,
        });
        expect(refused.status).toBe(409);
        expect(yield* machines).toEqual([]);
        const key = generateKeyPairSync("ed25519");
        expect((yield* dial(key)).status).toBe(403);
      }),
    60_000,
  );

  it.effect(
    "a host with a registered key connects over TLS, and one with an unknown key is refused",
    () =>
      Effect.gen(function* () {
        yield* hostedFeatures(true);

        // The host makes its key; the control plane registers the public half. No join link, no
        // Tailscale, and nothing to confirm.
        const registered = provisionHost("sandbox-1");
        const answer = yield* local(MACHINES_PROVISION_PATH, {
          name: registered.name,
          publicKey: registered.publicKey,
          platform: registered.platform,
        });
        expect(answer.status).toBe(200);
        expect(JSON.parse(answer.body)).toEqual({
          hostId: registered.hostId,
          fingerprint: registered.fingerprint,
          created: true,
          origin: ORIGIN,
        });
        // The same key again changes nothing.
        const again = yield* local(MACHINES_PROVISION_PATH, {
          name: registered.name,
          publicKey: registered.publicKey,
        });
        expect(JSON.parse(again.body)).toMatchObject({
          hostId: registered.hostId,
          created: false,
        });

        // A second host made its key the same way, but nobody registered it.
        const unknown = provisionHost("stranger");

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
        expect(online).toMatchObject({
          name: "sandbox-1",
          kind: "provisioned",
          confirmed: true,
        });

        // The unregistered host dialled too, signed with a key of its own, and was refused: it is
        // neither listed nor online, and its process says why it isn't connected.
        yield* until(
          Effect.sync(() => /not connected; dialling again/.test(stranger.output())),
          30,
          "the unregistered host to be refused",
        );
        expect(yield* machine(unknown.hostId)).toBeUndefined();
        expect((yield* machines).map((one) => one.id)).toEqual([registered.hostId]);

        // The same refusal, seen from the wire: a well-formed dial signed by a key nobody
        // registered gets 401 before any WebSocket is opened.
        const outsider = generateKeyPairSync("ed25519");
        const refused = yield* dial(outsider);
        expect(refused.status).toBe(401);
        expect(refused.body).toBe("unauthorized: machine not joined");
        // An unsigned dial, and one naming the registered host without its key.
        expect((yield* overTls({ path: HOST_CONNECT_PATH, upgrade: true })).status).toBe(401);
        expect(
          (yield* overTls({
            path: HOST_CONNECT_PATH,
            upgrade: true,
            headers: signedConnectHeaders(outsider.privateKey, ORIGIN, registered.hostId),
          })).status,
        ).toBe(401);

        // The listener serves hosts and nothing else: not the app, its socket, its settings
        // routes, a join or the installer, and not under another name or from a browser.
        for (const path of ["/", "/ws", "/mcp", MACHINES_LIST_PATH, "/host/join", "/host/install"])
          expect((yield* overTls({ path })).status, path).toBe(403);
        expect((yield* overTls({ path: MACHINES_PROVISION_PATH, method: "POST" })).status).toBe(
          403,
        );
        expect((yield* dial(outsider, ORIGIN, { host: "127.0.0.1" })).status).toBe(403);
        expect((yield* dial(outsider, ORIGIN, { origin: ORIGIN })).status).toBe(403);
        // Its app-tools endpoint takes a placed thread's token, not just any request.
        expect((yield* overTls({ path: HOST_MCP_PATH, method: "POST" })).status).toBe(401);

        // Turning hosted features off drops the host and refuses its dials; on again, it is back
        // without registering anew.
        yield* hostedFeatures(false);
        yield* until(
          Effect.map(machine(registered.hostId), (one) => one?.onlineSince === undefined),
          15,
          "the host to be dropped when hosted features go off",
        );
        expect((yield* dial(outsider)).status).toBe(403);
        yield* hostedFeatures(true);
        yield* until(
          Effect.map(machine(registered.hostId), (one) => one?.onlineSince !== undefined),
          45,
          "the host to come back",
        );

        // Removed, its key is unknown again.
        expect((yield* local(MACHINES_REMOVE_PATH, { id: registered.hostId })).status).toBe(200);
        yield* until(
          Effect.sync(() => /not connected; dialling again/.test(running.output())),
          30,
          "the removed host to lose its connection",
        );
        expect(yield* machines).toEqual([]);
      }).pipe(Effect.scoped),
    180_000,
  );
});
