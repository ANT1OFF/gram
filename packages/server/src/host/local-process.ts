import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { keepRunningAfterQuitOn } from "@gram/contracts";
import { GitStateRuntime, PathProbe, Proc, Worktrees } from "@gram/git";
import * as Option from "effect/Option";
import { ThreadStore } from "../persistence/thread-store.ts";
import {
  connectLocalService,
  type LocalServiceSpec,
  localServiceEnv,
  localServicePaths,
  localServicePlatform,
  localServiceProgram,
  restartLocalService,
  startLocalService,
  stopLocalService,
} from "./local-service-unit.ts";
import { ensureLocalSecret } from "./local-handshake.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { liveScan } from "../ports/scan.ts";
import { spawnLocalHostKeeping } from "./child.ts";
import { filesOn } from "./files.ts";
import type { HostConnection } from "./protocol.ts";
import { type MachineParts, throughHost } from "./routing.ts";

/**
 * Starts this machine's host process in a scope of its own and connects to it: a host that doesn't
 * start or answer is closed at once, its reason logged, and `undefined` returned, so the server
 * keeps doing the work itself.
 */
const startHostProcess = (keptTerminals: string | undefined) =>
  Effect.gen(function* () {
    const scope = yield* Scope.fork(yield* Effect.scope);
    const started = yield* spawnLocalHostKeeping(keptTerminals).pipe(
      Scope.provide(scope),
      Effect.exit,
    );
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

/** Where Gram keeps a kept-running host's record of its sessions (`kept-sessions.ts`). */
const sessionsRecord = (dataDir: string) => join(dataDir, "local-host", "sessions.json");

/** Whether the record names a session the host `pid` may still hold. */
const recordHolds = (dataDir: string, pid: number): boolean => {
  try {
    // Read plainly here: the record's own reader lives with the runtime that writes it.
    const record = JSON.parse(readFileSync(sessionsRecord(dataDir), "utf8")) as {
      hostPid?: unknown;
      sessions?: unknown;
    };
    return record.hostPid === pid && Array.isArray(record.sessions) && record.sessions.length > 0;
  } catch {
    return false;
  }
};

/**
 * This machine's host as the service kept running after Gram quits: the one running already, or
 * one started now. A host from another release, with nothing of a thread in it, is restarted on
 * this release's; one still running work is used as it is (between releases the protocol only
 * grows) and replaced once a later start finds it idle. `undefined` when it can't be had, with why.
 */
const startKeptRunning = (spec: LocalServiceSpec, release: string | undefined) =>
  Effect.gen(function* () {
    // Made by the app, read by the host: only an app that holds it is served.
    const secret = ensureLocalSecret(spec.paths.secretFile);
    const connect = (withinMs: number) =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(yield* Effect.scope);
        const connected = yield* connectLocalService(spec.paths.socket, secret, withinMs).pipe(
          Scope.provide(scope),
          Effect.exit,
        );
        if (Exit.isFailure(connected)) {
          yield* Scope.close(scope, Exit.void);
          return undefined;
        }
        return { connection: connected.value, scope };
      });
    let found = yield* connect(500);
    if (found === undefined) {
      yield* startLocalService(spec);
      found = yield* connect(20_000);
    } else if (
      release !== undefined &&
      found.connection.hello.release !== undefined &&
      found.connection.hello.release !== release &&
      !recordHolds(spec.dataDir, found.connection.hello.pid)
    ) {
      const ready = yield* found.connection.stop
        .prepare({ checkouts: [] })
        .pipe(Effect.orElseSucceed(() => undefined));
      if (ready?.idle === true) {
        yield* Effect.logInfo("kept host: replacing an earlier release's idle host").pipe(
          Effect.annotateLogs({ was: found.connection.hello.release, now: release }),
        );
        yield* Scope.close(found.scope, Exit.void);
        yield* restartLocalService(spec);
        found = yield* connect(20_000);
      }
    }
    if (found === undefined)
      return yield* Effect.fail(new Error("The kept-running host didn't answer on its socket."));
    return found.connection;
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
    /** The host is the service kept running after Gram quits (`agents.keepRunningAfterQuit`). */
    readonly keptRunning?: boolean;
    /** Why the kept-running host was asked for and couldn't be had this run. */
    readonly keptRunningProblem?: string;
  }
>()("@gram/server/LocalHostProcess") {
  /**
   * With `hostProcess`, this machine's folders, worktrees, local git state and port scan go through
   * the host running as its own process (`gram-host`), over the host protocol. A host process that
   * can't start, or answers on another protocol version, leaves those parts in the server.
   */
  static readonly layerWith = (options: {
    readonly hostProcess: boolean;
    /** Where the host process keeps its threads' open terminals for its next start. */
    readonly keptTerminals?: string;
    /**
     * Gram's data folder and release, where the host can be kept running after Gram quits. With
     * `agents.keepRunningAfterQuit` on, the host is that service; with it off, one left from
     * when it was on is stopped.
     */
    readonly keptRunning?: { readonly dataDir: string; readonly release: string | undefined };
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
        const kept = options.keptRunning;
        const platform = localServicePlatform();
        if (kept !== undefined && platform !== undefined) {
          const store = Option.getOrUndefined(yield* Effect.serviceOption(ThreadStore));
          const wanted =
            store !== undefined &&
            (yield* store.getSettings.pipe(
              Effect.map(keepRunningAfterQuitOn),
              Effect.orElseSucceed(() => false),
            ));
          const paths = localServicePaths(kept.dataDir, platform);
          if (wanted) {
            const probe = Option.getOrUndefined(yield* Effect.serviceOption(PathProbe));
            const path = probe === undefined ? undefined : yield* probe.path;
            const spec: LocalServiceSpec = {
              dataDir: kept.dataDir,
              platform,
              paths,
              program: localServiceProgram(paths),
              env: localServiceEnv(options.keptTerminals, paths.secretFile, process.env, path),
            };
            const started = yield* startKeptRunning(spec, kept.release).pipe(Effect.exit);
            if (Exit.isSuccess(started)) {
              yield* Effect.logInfo("worker host: kept running after Gram quits").pipe(
                Effect.annotateLogs({ pid: started.value.hello.pid, service: paths.name }),
              );
              return {
                connection: started.value,
                parts: throughHost(started.value, inServer),
                keptRunning: true,
              };
            }
            const reason = Cause.squash(started.cause);
            const problem = reason instanceof Error ? reason.message : String(reason);
            yield* Effect.logWarning("worker host: couldn't keep it running after Gram quits").pipe(
              Effect.annotateLogs({ reason: problem }),
            );
            const connection = options.hostProcess
              ? yield* startHostProcess(options.keptTerminals)
              : undefined;
            return {
              connection,
              parts: connection === undefined ? inServer : throughHost(connection, inServer),
              keptRunningProblem: problem,
            };
          }
          // Turned off: a service left from when it was on stops, and whatever ran in it.
          if (existsSync(paths.serviceFile)) {
            yield* Effect.logInfo("worker host: stopping the host kept running after Gram quit");
            yield* stopLocalService(platform, paths).pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  "worker host: the host kept running after Gram quit didn't stop",
                ).pipe(Effect.annotateLogs({ reason: error.message })),
              ),
            );
          }
        }
        const connection = options.hostProcess
          ? yield* startHostProcess(options.keptTerminals)
          : undefined;
        return {
          connection,
          parts: connection === undefined ? inServer : throughHost(connection, inServer),
        };
      }),
    );

  /** On when `GRAM_HOST_PROCESS=1`. */
  static readonly layer: Layer.Layer<LocalHostProcess, never, Worktrees | GitStateRuntime | Proc> =
    LocalHostProcess.layerKeeping(undefined);

  /** On when `GRAM_HOST_PROCESS=1`, keeping its threads' open terminals in `keptTerminals`. */
  static layerKeeping(
    keptTerminals: string | undefined,
    keptRunning?: { readonly dataDir: string; readonly release: string | undefined },
  ): Layer.Layer<LocalHostProcess, never, Worktrees | GitStateRuntime | Proc> {
    return Layer.suspend(() =>
      LocalHostProcess.layerWith({
        hostProcess: process.env["GRAM_HOST_PROCESS"] === "1",
        ...(keptTerminals === undefined ? {} : { keptTerminals }),
        ...(keptRunning === undefined ? {} : { keptRunning }),
      }),
    );
  }

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
