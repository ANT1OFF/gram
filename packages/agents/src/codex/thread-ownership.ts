import { AgentUnavailable } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { CodexRpc } from "./rpc.ts";

interface Owner {
  readonly home: string;
  readonly rpc: CodexRpc;
  readonly onClosing: () => void;
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

/**
 * Provider ownership outlives Gram's listeners and the acquisition cache. Each physical home has
 * one writer per thread, but only scopes on the exact same child/auth identity may share it.
 * At pinned 0.162.1, thread/closed can follow failed persistence shutdown while the shared
 * recorder retains its writer. Neither that notification nor unsubscribe proves release;
 * only observed owning-child exit clears our fence. No lock-file probing, delay/retry, or
 * termination of held siblings belongs here.
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
      // The cached child must eventually exit even for ordinary eviction. This only retires
      // acquisition; its held siblings remain alive and only owner.exit releases the writer.
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
              // Pinned 0.162.1 has no qualified protocol acknowledgement of recorder/writer release.
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
    owner: (home: string, rpc: CodexRpc, onClosing: () => void) => {
      const owner: Owner = { home, rpc, onClosing, exited: false, unknownOpen: false };
      owners.add(owner);
      const available = (threadId: string) =>
        Effect.suspend(() => {
          if (owner.exited) return Effect.fail(unavailable(threadId, "owning app-server exited"));
          if ([...owners].some((other) => other.home === home && other.unknownOpen)) {
            return Effect.fail(
              unavailable(
                threadId,
                "a provider open has unknown identity; awaiting owning app-server exit",
              ),
            );
          }
          return Effect.void;
        });
      return {
        // No reservation or finalizer while waiting: cancellation cannot release the old writer.
        // The host acquires a held server only afterwards, so another config change during this
        // wait cannot bind the replacement to a stale child or configuration.
        waitForExit: (threadId: string, onWait: Effect.Effect<void>) =>
          Effect.suspend(() => {
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
        exit: () => {
          owner.exited = true;
          owners.delete(owner);
          for (const lease of threads.values()) if (lease.owner === owner) release(lease);
        },
        open: <A extends { readonly thread: { readonly id: string } }, E, R>(
          resumeId: string | undefined,
          opening: Effect.Effect<A, E, R>,
        ): Effect.Effect<A, E | AgentUnavailable, R | Scope.Scope> => {
          const acquire = Effect.gen(function* () {
            yield* available(resumeId ?? "new");
            const key = resumeId === undefined ? undefined : keyFor(home, resumeId);
            let lease = key === undefined ? undefined : threads.get(key);
            if (lease !== undefined && lease.state.phase === "closing") {
              const closing = lease;
              const state = lease.state;
              yield* Deferred.await(closing.released).pipe(
                Effect.timeoutOrElse({
                  duration: timeoutMs,
                  orElse: () =>
                    Effect.fail(
                      unavailable(
                        closing.threadId,
                        state.closed
                          ? `${state.detail}; thread/closed does not prove writer release`
                          : state.detail,
                      ),
                    ),
                }),
              );
              lease = undefined;
            }
            yield* available(resumeId ?? "new");
            if (lease?.uncertainOpen)
              return yield* unavailable(
                lease.threadId,
                "provider open gave no answer; awaiting owning app-server exit",
              );
            if (lease !== undefined && lease.owner !== owner) {
              return yield* unavailable(
                lease.threadId,
                `${lease.state.phase === "open" ? lease.state.users : 0} Gram scope(s) still open`,
              );
            }
            const makeLease = (threadId: string): ThreadLease => ({
              owner,
              threadId,
              released: Deferred.makeUnsafe<void>(),
              state: { phase: "open", users: 1 },
              uncertainOpen: false,
            });
            // Reserve the reference before sending resume: another scope may close during its RPC.
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
                  // A timed-out RPC may still load a writer after a close notification. With no
                  // settled reply, only process exit is conclusive; an unknown new ID fences its home.
                  if (reserved === undefined) owner.unknownOpen = true;
                  else reserved.uncertainOpen = true;
                  return Effect.fail(
                    unavailable(
                      resumeId ?? "new",
                      "provider open gave no answer; awaiting owning app-server exit",
                    ),
                  );
                },
              }),
              Effect.onError(() => (reserved === undefined ? Effect.void : close(reserved))),
            );
            if (owner.exited)
              return yield* unavailable(started.thread.id, "owning app-server exited during open");
            if (lease === undefined) {
              const returnedKey = keyFor(home, started.thread.id);
              const known = threads.get(returnedKey);
              if (known !== undefined) {
                owner.unknownOpen = true;
                return yield* unavailable(
                  started.thread.id,
                  "provider returned an already-owned new identity; awaiting owning app-server exit",
                );
              }
              lease = makeLease(started.thread.id);
              threads.set(returnedKey, lease);
            } else if (lease.threadId !== started.thread.id) {
              owner.unknownOpen = true;
              yield* close(lease);
              return yield* unavailable(
                started.thread.id,
                "provider returned a different resume identity",
              );
            }
            return { started, lease };
          });
          // The lease is installed before any post-open validation can fail or be interrupted.
          return Effect.acquireRelease(
            resumeId === undefined ? acquire : serialized(keyFor(home, resumeId), acquire),
            ({ lease }) => close(lease),
          ).pipe(Effect.map(({ started }) => started));
        },
      };
    },
  };
};
