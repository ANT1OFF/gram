import { GitStateRuntime, Proc, Worktrees } from "@gram/git";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { liveScan } from "../ports/scan.ts";
import { spawnLocalHost } from "./child.ts";
import { filesOn } from "./files.ts";
import type { HostConnection } from "./protocol.ts";
import { type MachineParts, throughHost } from "./routing.ts";

/**
 * Starts this machine's host process in a scope of its own and connects to it: a host that doesn't
 * start or answer is closed at once, its reason logged, and `undefined` returned, so the server
 * keeps doing the work itself.
 */
const startHostProcess = Effect.gen(function* () {
  const scope = yield* Scope.fork(yield* Effect.scope);
  const started = yield* spawnLocalHost.pipe(Scope.provide(scope), Effect.exit);
  if (Exit.isFailure(started)) {
    yield* Scope.close(scope, Exit.void);
    const reason = Cause.squash(started.cause);
    yield* Effect.logWarning("worker host: its process didn't start; it runs in the server").pipe(
      Effect.annotateLogs({ reason: reason instanceof Error ? reason.message : String(reason) }),
    );
    return undefined;
  }
  yield* Effect.logInfo("worker host: running as its own process").pipe(
    Effect.annotateLogs({ pid: started.value.hello.pid }),
  );
  return started.value;
});

/**
 * This machine's parts, each through the host process while it runs and in the server otherwise.
 * One per server, so the worker host and the checkouts it creates share one host process.
 */
export class LocalHostProcess extends Context.Service<
  LocalHostProcess,
  {
    /** The host process's connection; absent when it isn't on or didn't start. */
    readonly connection: HostConnection | undefined;
    readonly parts: MachineParts;
  }
>()("@gram/server/LocalHostProcess") {
  /**
   * With `hostProcess`, this machine's folders, worktrees, local git state and port scan go through
   * the host running as its own process (`gram-host`), over the host protocol. A host process that
   * can't start, or answers on another protocol version, leaves those parts in the server.
   */
  static readonly layerWith = (options: {
    readonly hostProcess: boolean;
  }): Layer.Layer<LocalHostProcess, never, Worktrees | GitStateRuntime | Proc> =>
    Layer.effect(
      LocalHostProcess,
      Effect.gen(function* () {
        const proc = yield* Proc;
        const inServer: MachineParts = {
          files: filesOn(proc),
          worktrees: yield* Worktrees,
          git: yield* GitStateRuntime,
          scan: liveScan.pipe(Effect.provideService(Proc, proc)),
        };
        const connection = options.hostProcess ? yield* startHostProcess : undefined;
        return {
          connection,
          parts: connection === undefined ? inServer : throughHost(connection, inServer),
        };
      }),
    );

  /** On when `GRAM_HOST_PROCESS=1`. */
  static readonly layer: Layer.Layer<LocalHostProcess, never, Worktrees | GitStateRuntime | Proc> =
    Layer.suspend(() =>
      LocalHostProcess.layerWith({ hostProcess: process.env["GRAM_HOST_PROCESS"] === "1" }),
    );

  /**
   * `Worktrees` through the host process while it runs: provided to the checkouts' service, so a
   * thread's new or restored worktree is made by the host.
   */
  static readonly worktrees: Layer.Layer<Worktrees, never, LocalHostProcess> = Layer.effect(
    Worktrees,
    Effect.gen(function* () {
      return (yield* LocalHostProcess).parts.worktrees;
    }),
  );
}
