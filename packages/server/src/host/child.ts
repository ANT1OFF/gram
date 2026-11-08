import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { HostUnavailable, LOCAL_HOST_ID } from "@gram/contracts";
import * as Effect from "effect/Effect";
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
    if (child.exitCode !== null || child.signalCode !== null) return resume(Effect.void);
    const timer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resume(Effect.void);
    });
    child.kill("SIGTERM");
  });

/**
 * This machine's host in a child process of the server, connected over a pipe on descriptor 3.
 * Under Electron the child runs as plain Node. The child ends with the scope.
 */
export const spawnLocalHost: Effect.Effect<HostConnection, HostUnavailable, Scope.Scope> =
  Effect.gen(function* () {
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(process.execPath, [hostEntry()], {
          stdio: ["ignore", "ignore", "inherit", "pipe"],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        }),
      ),
      stop,
    );
    const stream = child.stdio[3] as Duplex | null | undefined;
    if (stream === null || stream === undefined) {
      return yield* new HostUnavailable({
        hostId: LOCAL_HOST_ID,
        message: "The host process started without its stream.",
      });
    }
    const socket = yield* NodeSocket.fromDuplex(Effect.succeed(stream));
    return yield* connectHost(socket);
  });
