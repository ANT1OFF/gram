import { AgentUnavailable } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { CodexRpc } from "./rpc.ts";

interface Owner {
  readonly home: string;
  readonly rpc: CodexRpc;
  readonly pid: number | undefined;
  readonly onClosing: () => void;
  readonly gone: Deferred.Deferred<void>;
  exited: boolean;
  unknownOpen: boolean;
}
interface ThreadLease {
  readonly owner: Owner;
  readonly threadId: string;
  readonly released: Deferred.Deferred<void>;
  uncertainOpen: boolean;
  state: { phase: "open"; users: number } | { phase: "closing"; detail: string; closed: boolean };
}

const keyFor = (home: string, threadId: string) => JSON.stringify([home, threadId]);
const unavailable = (threadId: string, detail: string) =>
  new AgentUnavailable({
    agent: "codex",
    reason: "startup-failed",
    message: `Codex thread ${threadId} is still owned by another session or awaiting provider closure (${detail}). Resume was refused. Close its remaining Gram sessions or try again after the owning app-server exits.`,
  });
const pidOf = (owner: Owner) => (owner.pid === undefined ? "unknown pid" : `pid ${owner.pid}`);
const refuseLogged = (threadId: string, detail: string, blockers: ReadonlyArray<Owner>) =>
  Effect.logWarning(
    `codex open refused: thread ${threadId}, ${detail}; held by app-server ${blockers.map(pidOf).join(", ") || "none"}`,
  ).pipe(Effect.andThen(Effect.fail(unavailable(threadId, detail))));
const processKnownAlive = (pid: number | undefined) => {
  if (pid === undefined) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

/**
 * Provider ownership outlives Gram's listeners and the acquisition cache. Each physical home has
 * one writer per thread, but only scopes on the exact same child/auth identity may share it.
 * Measured at 0.162.1 and assumed since: thread/closed can follow failed persistence shutdown
 * while the shared recorder retains its writer. Neither that notification nor unsubscribe proves
 * release; only observed owning-child exit (or its pid gone) clears our fence. No lock-file probing,
 * retry, or termination of held siblings belongs here.
 *
 * An open whose answer never came (or named an identity already owned) leaves its app-server
 * holding a thread Gram can't name. That app-server is retired so it stops once its sessions close,
 * and until it exits a resume on its home waits for that exit and is then refused: the unnamed
 * thread could be the one being resumed. A new thread is not fenced by it: the provider gives every
 * new thread a fresh id, and an id that is already owned is still refused once the open returns.
 */
export const makeThreadOwnership = (
  timeoutMs: number,
  openTimeoutMs: number,
  run: (effect: Effect.Effect<void>) => void,
) => {
  const threads = new Map<string, ThreadLease>();
  const owners = new Set<Owner>();
  const locks = new Map<string, { lock: Semaphore.Semaphore; users: number }>();

  const serialized = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        let entry = locks.get(key);
        if (entry === undefined) {
          entry = { lock: Semaphore.makeUnsafe(1), users: 0 };
          locks.set(key, entry);
        }
        entry.users++;
        return entry;
      }),
      (entry) => entry.lock.withPermits(1)(effect),
      (entry) =>
        Effect.sync(() => {
          if (--entry.users === 0) locks.delete(key);
        }),
    );

  const release = (lease: ThreadLease) => {
    const key = keyFor(lease.owner.home, lease.threadId);
    if (threads.get(key) !== lease) return;
    threads.delete(key);
    Deferred.doneUnsafe(lease.released, Effect.void);
  };
  const exit = (gone: Owner) => {
    gone.exited = true;
    owners.delete(gone);
    for (const lease of threads.values()) if (lease.owner === gone) release(lease);
    Deferred.doneUnsafe(gone.gone, Effect.void);
  };
  const clearVanishedOwners = () => {
    for (const owner of owners) if (!processKnownAlive(owner.pid)) exit(owner);
  };
  const close = (lease: ThreadLease) =>
    Effect.sync(() => {
      if (lease.state.phase !== "open" || --lease.state.users !== 0) return;
      if (threads.get(keyFor(lease.owner.home, lease.threadId)) !== lease) return;
      const closing = {
        phase: "closing" as const,
        closed: false,
        detail: lease.uncertainOpen
          ? "provider open gave no answer; awaiting owning app-server exit"
          : "waiting for thread/unsubscribe; awaiting owning app-server exit",
      };
      lease.state = closing;
      lease.owner.onClosing();
      run(
        lease.owner.rpc.request("thread/unsubscribe", { threadId: lease.threadId }).pipe(
          Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed(undefined) }),
          Effect.match({
            onFailure: (error) => {
              if (lease.uncertainOpen) return;
              closing.detail = `thread/unsubscribe failed: ${error.message}; awaiting owning app-server exit`;
            },
            onSuccess: (response) => {
              if (lease.uncertainOpen) return;
              const status = response?.status;
              closing.detail =
                response === undefined
                  ? "thread/unsubscribe gave no answer; awaiting owning app-server exit"
                  : status === "notLoaded" ||
                      status === "notSubscribed" ||
                      status === "unsubscribed"
                    ? `thread/unsubscribe status ${status}; awaiting owning app-server exit`
                    : "thread/unsubscribe returned an unknown status; awaiting owning app-server exit";
            },
          }),
        ),
      );
    });

  return {
    /**
     * `pid` is the app-server's process; `dedicated` when it serves one Gram thread only (a
     * worker's or orchestrator's own).
     */
    owner: (
      home: string,
      rpc: CodexRpc,
      { pid, dedicated }: { readonly pid: number | undefined; readonly dedicated: boolean },
      onClosing: () => void,
    ) => {
      const owner: Owner = {
        home,
        rpc,
        pid,
        onClosing,
        gone: Deferred.makeUnsafe<void>(),
        exited: false,
        unknownOpen: false,
      };
      owners.add(owner);
      const unknownOwners = () => {
        clearVanishedOwners();
        return [...owners].filter((other) => other.home === home && other.unknownOpen);
      };
      const available = (threadId: string, resuming: boolean) =>
        Effect.suspend(() => {
          clearVanishedOwners();
          if (owner.exited) return refuseLogged(threadId, "owning app-server exited", [owner]);
          if (!resuming) return Effect.void;
          const blockers = unknownOwners();
          if (blockers.length === 0) return Effect.void;
          return Effect.forEach(blockers, (other) => Deferred.await(other.gone), {
            discard: true,
          }).pipe(
            Effect.timeoutOrElse({
              duration: timeoutMs,
              orElse: () => {
                const still = unknownOwners();
                return still.length === 0
                  ? Effect.void
                  : refuseLogged(
                      threadId,
                      "a provider open has unknown identity; awaiting owning app-server exit",
                      still,
                    );
              },
            }),
            Effect.andThen(
              Effect.suspend(() =>
                owner.exited
                  ? refuseLogged(threadId, "owning app-server exited", [owner])
                  : Effect.void,
              ),
            ),
          );
        });
      const retireUnaccounted = () => {
        owner.unknownOpen = true;
        owner.onClosing();
      };
      const holdsNothing = () => ![...threads.values()].some((lease) => lease.owner === owner);
      const retireIfFailedAlone = () => {
        if (dedicated && holdsNothing()) owner.onClosing();
      };
      return {
        waitForExit: (threadId: string, onWait: Effect.Effect<void>) =>
          Effect.suspend(() => {
            clearVanishedOwners();
            const lease = threads.get(keyFor(home, threadId));
            return lease === undefined
              ? Effect.void
              : onWait.pipe(Effect.andThen(Deferred.await(lease.released)));
          }),
        /** Called by the RPC reader in wire order, before queued listener delivery or RPC replies. */
        closed: (threadId: string) => {
          const lease = threads.get(keyFor(home, threadId));
          if (lease?.owner === owner && lease.state.phase === "closing") lease.state.closed = true;
        },
        /** Must also run for exit before the session subscribes or open's reply arrives. */
        exit: () => exit(owner),
        open: <A extends { readonly thread: { readonly id: string } }, E, R>(
          resumeId: string | undefined,
          opening: Effect.Effect<A, E, R>,
        ): Effect.Effect<A, E | AgentUnavailable, R | Scope.Scope> => {
          const acquire = Effect.gen(function* () {
            yield* available(resumeId ?? "new", resumeId !== undefined);
            const key = resumeId === undefined ? undefined : keyFor(home, resumeId);
            let lease = key === undefined ? undefined : threads.get(key);
            if (lease !== undefined && lease.state.phase === "closing") {
              const closing = lease;
              const state = lease.state;
              yield* Deferred.await(closing.released).pipe(
                Effect.timeoutOrElse({
                  duration: timeoutMs,
                  orElse: () =>
                    refuseLogged(
                      closing.threadId,
                      state.closed
                        ? `${state.detail}; thread/closed does not prove writer release`
                        : state.detail,
                      [closing.owner],
                    ),
                }),
              );
              lease = undefined;
            }
            yield* available(resumeId ?? "new", resumeId !== undefined);
            if (lease?.uncertainOpen)
              return yield* refuseLogged(
                lease.threadId,
                "provider open gave no answer; awaiting owning app-server exit",
                [lease.owner],
              );
            if (lease !== undefined && lease.owner !== owner) {
              return yield* refuseLogged(
                lease.threadId,
                `${lease.state.phase === "open" ? lease.state.users : 0} Gram scope(s) still open`,
                [lease.owner],
              );
            }
            const makeLease = (threadId: string): ThreadLease => ({
              owner,
              threadId,
              released: Deferred.makeUnsafe<void>(),
              state: { phase: "open", users: 1 },
              uncertainOpen: false,
            });
            if (lease !== undefined && lease.state.phase === "open") lease.state.users++;
            else if (resumeId !== undefined) {
              lease = makeLease(resumeId);
              threads.set(keyFor(home, resumeId), lease);
            }
            const reserved = lease;
            const started = yield* opening.pipe(
              Effect.timeoutOrElse({
                duration: openTimeoutMs,
                orElse: () => {
                  if (reserved === undefined) retireUnaccounted();
                  else reserved.uncertainOpen = true;
                  return refuseLogged(
                    resumeId ?? "new",
                    "provider open gave no answer; awaiting owning app-server exit",
                    [owner],
                  );
                },
              }),
              Effect.onError(() => (reserved === undefined ? Effect.void : close(reserved))),
            );
            if (owner.exited)
              return yield* refuseLogged(
                started.thread.id,
                "owning app-server exited during open",
                [owner],
              );
            if (lease === undefined) {
              const returnedKey = keyFor(home, started.thread.id);
              const known = threads.get(returnedKey);
              if (known !== undefined) {
                retireUnaccounted();
                return yield* refuseLogged(
                  started.thread.id,
                  "provider returned an already-owned new identity; awaiting owning app-server exit",
                  [owner, known.owner],
                );
              }
              lease = makeLease(started.thread.id);
              threads.set(returnedKey, lease);
            } else if (lease.threadId !== started.thread.id) {
              owner.unknownOpen = true;
              yield* close(lease);
              return yield* refuseLogged(
                started.thread.id,
                "provider returned a different resume identity",
                [owner],
              );
            }
            return { started, lease };
          }).pipe(Effect.onError(() => Effect.sync(retireIfFailedAlone)));
          return Effect.acquireRelease(
            resumeId === undefined ? acquire : serialized(keyFor(home, resumeId), acquire),
            ({ lease }) => close(lease),
          ).pipe(Effect.map(({ started }) => started));
        },
      };
    },
  };
};
