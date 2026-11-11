// A headless control plane as two real processes, started as the Docker image starts them: the
// server (`node main.ts` with `GRAM_HEADLESS=1`) and a provisioned `gram-host` on the fake agent,
// which dials the server's TLS listener. An orchestrator and a worker run in the host's process;
// the server's has no agent to run them with.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { GramRpcs, type Thread, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { eventually, hasGit, makeRepo } from "../git/test-repo.ts";
import { RpcClient, RpcSerialization, Socket } from "../platform/unstable.ts";
import { HEADLESS_NEEDS_HOSTED, NO_MACHINE_JOINED } from "./headless.ts";

const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const temp = realpathSync(mkdtempSync(join(tmpdir(), "gram-headless-processes-")));
afterAll(() => rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const SERVER_ENTRY = fileURLToPath(new URL("../main.ts", import.meta.url));
const HOST_ENTRY = fileURLToPath(new URL("./main.ts", import.meta.url));
/**
 * The project's remote, which the host clones: a bare repository in the temp folder, named over
 * SSH, the one transport besides HTTPS a host's git allows.
 */
const BARE = join(temp, "widgets.git");
const REMOTE = `ssh://git@git.example.test${BARE}`;

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

/** A synthetic certificate for `localhost`, its own authority, made for this run alone. */
const makeCertificate = () => {
  const certFile = join(temp, "cert.pem");
  const keyFile = join(temp, "key.pem");
  const config = join(temp, "openssl.cnf");
  writeFileSync(
    config,
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
      config,
    ],
    { stdio: "ignore" },
  );
  return { certFile, keyFile };
};

/** A child of this test with what it printed, killed with the scope if it is still running. */
const started = (entry: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      let output = "";
      const child: ChildProcess = spawn(process.execPath, [entry, ...args], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
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

/** What the server's process starts with: a home and a data folder of its own, and no agent. */
const serverEnv = (name: string, extra: Record<string, string>): NodeJS.ProcessEnv => {
  const home = join(temp, name);
  mkdirSync(home, { recursive: true });
  const { GRAM_FAKE_AGENT: _fake, GRAM_EMBEDDING: _embedding, ...inherited } = process.env;
  return {
    ...inherited,
    HOME: home,
    XDG_DATA_HOME: join(home, "data"),
    XDG_CONFIG_HOME: join(home, "config"),
    GRAM_DATA_DIR: join(home, "state"),
    GRAM_PORT: "0",
    GRAM_HEADLESS: "1",
    ...extra,
  };
};

const post = (port: number, cookie: string, path: string, body: unknown) =>
  Effect.promise(
    () =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path,
            method: "POST",
            agent: false,
            headers: {
              cookie,
              origin: `http://127.0.0.1:${port}`,
              "content-type": "application/json",
            },
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => (text += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify(body));
      }),
  );

describe.skipIf(!hasGit || !hasOpenssl || process.platform === "win32")(
  "a headless control plane and a host, as two processes",
  () => {
    it.live(
      "the server's process doesn't start with the hosted features off",
      () =>
        Effect.gen(function* () {
          const server = yield* started(SERVER_ENTRY, [], serverEnv("server-off", {}));
          const code = yield* Effect.promise(
            () =>
              new Promise<number | null>((resolve) =>
                server.child.exitCode !== null
                  ? resolve(server.child.exitCode)
                  : server.child.once("exit", (exit) => resolve(exit)),
              ),
          );
          expect(code).not.toBe(0);
          expect(server.output()).toContain(HEADLESS_NEEDS_HOSTED);
          expect(server.output()).not.toMatch(/^boot http/m);
        }).pipe(Effect.scoped),
      60_000,
    );

    it.live(
      "an orchestrator and a worker run in the host's process, none in the server's",
      () =>
        Effect.gen(function* () {
          const { certFile, keyFile } = makeCertificate();
          const hostPort = yield* Effect.promise(unusedPort);
          const origin = `https://localhost:${hostPort}`;

          // The project as the control plane keeps it, and the repository its remote really is.
          const root = makeRepo(join(temp, "control-plane"));
          execFileSync("git", ["clone", "--quiet", "--bare", root, BARE]);
          execFileSync("git", ["-C", root, "remote", "add", "origin", REMOTE]);

          const server = yield* started(
            SERVER_ENTRY,
            [],
            serverEnv("server", {
              GRAM_EMBEDDING: "1",
              GRAM_PROVISIONED_ORIGIN: origin,
              GRAM_PROVISIONED_LISTEN_HOST: "127.0.0.1",
              GRAM_PROVISIONED_TLS_CERT: certFile,
              GRAM_PROVISIONED_TLS_KEY: keyFile,
            }),
          );
          const boot = yield* eventually(
            "the server's boot line",
            Effect.sync(() => {
              if (server.child.exitCode !== null)
                throw new Error(`the server exited:\n${server.output()}`);
              return (
                /^boot (http:\/\/127\.0\.0\.1:(\d+)\/\?boot=\S+)$/m.exec(server.output()) ??
                undefined
              );
            }),
            60_000,
          );
          const port = Number(boot[2]);
          const cookie = yield* Effect.promise(
            () =>
              new Promise<string>((resolve, reject) => {
                const req = httpRequest(boot[1]!, { agent: false }, (res) => {
                  res.resume();
                  resolve(res.headers["set-cookie"]?.[0]?.split(";")[0] ?? "");
                });
                req.on("error", reject);
                req.end();
              }),
          );
          expect(cookie).not.toBe("");
          const protocol = yield* Layer.build(
            RpcClient.layerProtocolSocket().pipe(
              Layer.provide(
                Socket.layerWebSocket(`ws://127.0.0.1:${port}/ws`, {
                  headers: { cookie },
                } as never),
              ),
              Layer.provide(NodeSocket.layerWebSocketConstructorWS),
              Layer.provide(RpcSerialization.layerJson),
            ),
          );
          const app = yield* RpcClient.make(GramRpcs).pipe(Effect.provideContext(protocol));

          const project = yield* app["projects.add"]({ root });
          const none = yield* app["orchestrator.open"]({ projectId: project.id }).pipe(Effect.flip);
          expect(none).toMatchObject({ message: NO_MACHINE_JOINED });

          const localSsh = join(temp, "local-ssh");
          writeFileSync(localSsh, '#!/bin/sh\nshift\nexec sh -c "$*"\n', { mode: 0o755 });

          // The host makes its key, the control plane registers it, and the host runs.
          const hostHome = join(temp, "host");
          const hostEnv: NodeJS.ProcessEnv = {
            ...process.env,
            GRAM_HOST_HOME: hostHome,
            GRAM_FAKE_AGENT: "1",
            GRAM_FAKE_AGENT_REPLY: "echo",
            NODE_EXTRA_CA_CERTS: certFile,
            // Its SSH is a script that runs the remote's command here, whatever host it names.
            GIT_SSH_COMMAND: localSsh,
            GIT_SSH_VARIANT: "simple",
          };
          const provisioned = JSON.parse(
            execFileSync(
              process.execPath,
              [HOST_ENTRY, "provision", "--origin", origin, "--name", "sandbox-1"],
              { env: hostEnv, encoding: "utf8" },
            ),
          ) as { hostId: string; name: string; publicKey: string };
          const registered = yield* eventually(
            "the provisioned-host listener, and the host registered",
            Effect.map(
              post(port, cookie, "/machines/provision", {
                name: provisioned.name,
                publicKey: provisioned.publicKey,
                platform: process.platform,
              }),
              (answer) => (answer.status === 200 ? answer : undefined),
            ),
          );
          expect(JSON.parse(registered.body)).toMatchObject({ hostId: provisioned.hostId });
          const host = yield* started(HOST_ENTRY, ["run"], hostEnv);
          yield* eventually(
            "the host online with its models",
            Effect.map(post(port, cookie, "/machines/list", {}), (answer) => {
              if (host.child.exitCode !== null)
                throw new Error(`the host exited:\n${host.output()}`);
              const machines: ReadonlyArray<{
                id: string;
                onlineSince?: number;
                models?: unknown;
              }> = JSON.parse(answer.body).machines ?? [];
              return machines.some(
                (machine) =>
                  machine.id === provisioned.hostId &&
                  machine.onlineSince !== undefined &&
                  machine.models !== undefined,
              );
            }),
            60_000,
          );

          /** Waits for the fake agent's reply on a thread: it ran where the fake is, the host. */
          const echoed = (threadId: ThreadId) =>
            app["thread.subscribe"]({ threadId }).pipe(
              Stream.filter((event) => JSON.stringify(event).includes("echo: ")),
              Stream.runHead,
              Effect.timeout("30 seconds"),
            );
          const repos = join(hostHome, "repos");

          const orchestrator: Thread = yield* app["workspace.startTask"]({
            target: { projectId: project.id },
            input: { text: "Plan the work." },
          });
          expect(orchestrator.role).toBe("orchestrator");
          expect(orchestrator.checkout.hostId).toBe(provisioned.hostId);
          expect(orchestrator.checkout.path.startsWith(repos)).toBe(true);
          expect(existsSync(join(orchestrator.checkout.path, "tracked.txt"))).toBe(true);
          yield* echoed(orchestrator.id);

          const worker: Thread = yield* app["workspace.startTask"]({
            target: { projectId: project.id },
            input: { text: "Do the work." },
            direct: { projectId: project.id },
          });
          expect(worker.id).not.toBe(orchestrator.id);
          expect(worker.checkout.kind).toBe("worktree");
          expect(worker.checkout.hostId).toBe(provisioned.hostId);
          expect(worker.checkout.path.startsWith(repos)).toBe(true);
          expect(existsSync(join(worker.checkout.path, "tracked.txt"))).toBe(true);
          yield* echoed(worker.id);

          // Nothing was made on the control plane's side.
          expect(existsSync(join(root, ".worktrees"))).toBe(false);
          expect(server.child.exitCode).toBeNull();
        }).pipe(Effect.scoped),
      180_000,
    );
  },
);
