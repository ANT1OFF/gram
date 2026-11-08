import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { HostUnavailable, LOCAL_HOST_ID } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";
import { connectHost, type HostConnection } from "./protocol.ts";

/**
 * The host entry: its TypeScript source under the tests, the `gram-host.js` bundle beside the
 * server's own in a build.
 */
const hostEntry = (): string =>
  import.meta.url.endsWith(".ts")
    ? fileURLToPath(new URL("./main.ts", import.meta.url))
    : typeof __dirname === "string"
      ? join(__dirname, "gram-host.js")
      : fileURLToPath(new URL("./gram-host.js", import.meta.url));

/** How long a host gets to exit on its own before it is killed. */
const STOP_GRACE_MS = 3_000;

/** Stops our own child: its stream closes first, then a TERM, then a KILL if it lingers. */
const stop = (child: ChildProcess) =>
  Effect.callback<void>((resume) => {
    // Never started (a spawn error), or already gone: nothing to stop or wait for.
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      return resume(Effect.void);
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resume(Effect.void);
    });
    child.kill("SIGTERM");
  });

/**
 * This machine's host in a child process of the server, connected over a pipe on descriptor 3.
 * Under Electron the child runs as plain Node. A child that fails to start, exits, or doesn't
 * answer fails the connection with `HostUnavailable`, and calls in flight with it. The child ends
 * with the scope.
 */
export const spawnHost = (
  command: { readonly file: string; readonly args: ReadonlyArray<string> } = {
    file: process.execPath,
    args: [hostEntry()],
  },
): Effect.Effect<HostConnection, HostUnavailable, Scope.Scope> =>
  Effect.gen(function* () {
    const ended = yield* Deferred.make<never, HostUnavailable>();
    const end = (message: string) =>
      Deferred.doneUnsafe(
        ended,
        Exit.fail(new HostUnavailable({ hostId: LOCAL_HOST_ID, message })),
      );
    const child = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const spawned = spawn(command.file, [...command.args], {
          stdio: ["ignore", "ignore", "inherit", "pipe"],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        });
        // Before anything else: a spawn that fails emits `error`, which unheard ends the server.
        spawned.on("error", (error) => end(`The host process failed: ${error.message}`));
        spawned.once("exit", (code, signal) =>
          end(`The host process exited (${signal ?? `code ${code}`}).`),
        );
        return spawned;
      }),
      stop,
    );
    const stream = child.stdio[3] as Duplex | null | undefined;
    // A pipe reset when the child goes is the exit's news, which `end` reports; unheard, the
    // stream's own `error` would end the server.
    stream?.on("error", () => {});
    if (child.pid === undefined || stream === null || stream === undefined) {
      return yield* new HostUnavailable({
        hostId: LOCAL_HOST_ID,
        message: "The host process didn't start.",
      });
    }
    const socket = yield* NodeSocket.fromDuplex(Effect.succeed(stream));
    return yield* connectHost(socket, {
      hostId: LOCAL_HOST_ID,
      gone: Deferred.await(ended),
      // A host found gone over its stream (it stopped answering) may still be running: stop it.
      onEnded: () => stop(child),
    }).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("worker host: its process didn't connect").pipe(
          Effect.annotateLogs({ reason: error.message }),
        ),
      ),
    );
  });

/** This machine's host process, from the build's own `gram-host` entry. */
export const spawnLocalHost: Effect.Effect<HostConnection, HostUnavailable, Scope.Scope> =
  spawnHost();
