import { describe, expect, it } from "@effect/vitest";
import { AgentUnavailable } from "@gram/contracts";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import { beginChildShutdownCheck } from "../child-process.ts";
import { GatewayKeyProvider } from "../gateway.ts";
import { CodexServers, CodexServersLive } from "./servers.ts";

// A real production CodexServers lifecycle over an invented child CLI and owned shell probe.
// Its second ordinary RPC completes then ends the child; no account/provider is consulted.
const fixture = (exitCode: number, hangInitialize = false) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gram-codex-shutdown-")));
  const initializeSocket = join(root, "initialize.sock");
  const initialized = Promise.withResolvers<number>();
  // Filesystem notifications can be lost under load. A stream handshake also buffers readiness
  // if initialize arrives before the test awaits it, and never exposes a partially written pid.
  const listener = hangInitialize
    ? createServer((socket) => {
        let pid = "";
        socket.setEncoding("utf8");
        socket.on("data", (data: string) => (pid += data));
        socket.on("end", () => initialized.resolve(Number(pid)));
      })
    : undefined;
  const listening =
    listener === undefined
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          listener.once("error", reject);
          listener.listen(initializeSocket, () => {
            listener.removeListener("error", reject);
            resolve();
          });
        });
  const binary = join(root, "codex"),
    shell = join(root, "shell");
  writeFileSync(
    binary,
    `#!${process.execPath}
if (process.argv.includes("--version")) { console.log("codex-cli 0.160.0"); process.exit(0); }
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize" && ${hangInitialize}) {
    const socket = require("node:net").createConnection(${JSON.stringify(initializeSocket)}, () => {
      socket.end(String(process.pid));
    });
    return;
  }
  if (message.id === undefined) return;
  const result = message.method === "thread/list" ? { data: [], nextCursor: null } : {};
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n", () => {
    if (message.method === "thread/list") process.exit(${exitCode});
  });
});
`,
  );
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, CODEX_HOME: root };
  writeFileSync(
    shell,
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(
      `\0__SB_PROBE__\0${binary}\n\0__SB_ENV__\0${Object.entries(env)
        .map(([k, v]) => `${k}=${v}\0`)
        .join("")}`,
    )});\n`,
  );
  chmodSync(binary, 0o755);
  chmodSync(shell, 0o755);
  const close = async () => {
    if (listener !== undefined)
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
    rmSync(root, { recursive: true, force: true });
  };
  return { binary, shell, listening, initialized: initialized.promise, close };
};

const keys = Layer.succeed(GatewayKeyProvider)({
  credentials: () =>
    Effect.fail(
      new AgentUnavailable({ agent: "codex", message: "No gateway in shutdown fixture" }),
    ),
});

const notCheckingShutdown = () => true;

describe.skipIf(process.platform === "win32")("owned CodexServers exit observation", () => {
  it.effect("reaps an uncached child when startup is cancelled", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => fixture(0, true)),
      (f) =>
        Effect.gen(function* () {
          const servers = yield* CodexServers;
          yield* Effect.promise(() => f.listening);
          const opening = yield* Effect.forkScoped(servers.acquire(undefined, "user"));
          const pid = yield* Effect.promise(() => f.initialized).pipe(Effect.timeout("5 seconds"));
          // `process.kill(0, 0)` signals this process's own group, so it never throws.
          expect(pid).toBeGreaterThan(0);
          expect(() => process.kill(pid, 0)).not.toThrow();
          yield* Fiber.interrupt(opening);
          expect(yield* servers.running).toEqual([]);
          yield* servers.retireAll;
          expect(() => process.kill(pid, 0)).toThrow();
        }).pipe(
          Effect.provide(
            CodexServersLive({
              binaryPath: f.binary,
              shell: f.shell,
              startupTimeoutMs: 30_000,
            }).pipe(Layer.provide(keys)),
          ),
        ),
      (f) => Effect.promise(f.close),
    ),
  );

  for (const [code, duringShutdown] of [
    [3, true],
    [0, true],
    [3, false],
  ] as const) {
    it.effect(
      `observes natural exit ${code}, shutdown active ${duringShutdown}, before host removal`,
      () =>
        Effect.acquireUseRelease(
          Effect.sync(() => fixture(code)),
          (f) => {
            let orderly = notCheckingShutdown;
            return Effect.gen(function* () {
              const servers = yield* CodexServers;
              const server = yield* servers.acquire(undefined, "user");
              const exited = Promise.withResolvers<void>();
              yield* server.subscribe("synthetic-thread", {
                message: () => {},
                exit: () => exited.resolve(),
              });
              if (duringShutdown) orderly = beginChildShutdownCheck();
              yield* server.rpc.request("thread/list", {}).pipe(Effect.ignore);
              yield* Effect.promise(() => exited.promise).pipe(Effect.timeout("5 seconds"));
              // Production removal already happened; the layer's stopChild cannot inspect this child.
              expect(yield* servers.running).toEqual([]);
              if (!duringShutdown) orderly = beginChildShutdownCheck();
              expect(orderly()).toBe(!duringShutdown || code === 0);
            }).pipe(
              Effect.provide(
                CodexServersLive({
                  binaryPath: f.binary,
                  shell: f.shell,
                  startupTimeoutMs: 2_000,
                }).pipe(Layer.provide(keys)),
              ),
              Effect.andThen(
                Effect.sync(() => expect(orderly()).toBe(!duringShutdown || code === 0)),
              ),
            );
          },
          (f) => Effect.promise(f.close),
        ),
    );
  }
});
