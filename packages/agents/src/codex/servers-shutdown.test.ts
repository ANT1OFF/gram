import { describe, expect, it } from "@effect/vitest";
import { AgentUnavailable } from "@gram/contracts";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
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
  const pidFile = join(root, "initialize.pid");
  const binary = join(root, "codex"),
    shell = join(root, "shell");
  writeFileSync(
    binary,
    `#!${process.execPath}
if (process.argv.includes("--version")) { console.log("codex-cli 0.160.0"); process.exit(0); }
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize" && ${hangInitialize}) {
    require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
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
  return { root, binary, shell, pidFile };
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
          const initialized = Effect.callback<number>((resume) => {
            const read = () => {
              if (existsSync(f.pidFile))
                resume(Effect.sync(() => Number(readFileSync(f.pidFile, "utf8"))));
            };
            const watcher = watch(f.root, read);
            read();
            return Effect.sync(() => watcher.close());
          });
          const opening = yield* Effect.forkScoped(servers.acquire(undefined, "user"));
          const pid = yield* initialized.pipe(Effect.timeout("5 seconds"));
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
      (f) => Effect.sync(() => rmSync(f.root, { recursive: true, force: true })),
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
          (f) => Effect.sync(() => rmSync(f.root, { recursive: true, force: true })),
        ),
    );
  }
});
