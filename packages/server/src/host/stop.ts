// A host readied to be stopped with its disk kept (`host.stop.prepare`): it stops taking new work,
// says whether anything still runs on it, and keeps each thread's work in progress off the machine
// under a hidden ref (`@gram/git`'s `wip.ts`). Whoever runs the machine then stops it; a host
// started later on the same disk finds the folders, branches and agent transcripts as they were.

import {
  type HostBusy,
  HostFailed,
  type HostStopCheckout,
  type HostStopKept,
  type HostStopPrepared,
} from "@gram/contracts";
import { isPushRemote, Proc, type ProcShape, pushWip, snapshotWip } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { Admission } from "./admission.ts";
import { redactUrlCredentials } from "./remote-url.ts";

/** Why new work is refused while the host is readied to stop. */
export const STOPPING = "This machine is about to stop. Try again once it is back.";

/** How long a host readied to stop refuses new work when no stop and no cancel follows. */
export const STOP_HOLD_MS = 10 * 60_000;

/** How many folders are committed and pushed at a time. */
const KEEP_CONCURRENCY = 4;

export interface StopRequest {
  readonly checkouts: ReadonlyArray<HostStopCheckout>;
  readonly force?: boolean | undefined;
  readonly remote?: string | undefined;
}

/** A host's readiness to stop, as it serves `host.stop.*`. */
export interface HostStop {
  readonly prepare: (request: StopRequest) => Effect.Effect<HostStopPrepared, HostFailed>;
  readonly cancel: Effect.Effect<void>;
  /** Whether new work is refused now because the host was readied to stop. */
  readonly stopping: () => boolean;
}

export interface StopDeps {
  readonly proc: ProcShape;
  /** What runs on the host now, as its update reads it. */
  readonly busy: Effect.Effect<HostBusy>;
  /** The host's gate for new work: what was let in and hasn't answered, and an update's hold. */
  readonly admission: Pick<Admission, "inflight" | "closed">;
  /** Lets a folder through, or says why not: a joined machine's folder gate. */
  readonly admit?: (cwd: string) => Effect.Effect<unknown, { readonly message: string }>;
  readonly now?: () => number;
  readonly holdMs?: number;
}

const isBusy = (busy: HostBusy) => busy.turns + busy.terminals + busy.clones + busy.checks > 0;

const note = (message: string) => redactUrlCredentials(message).slice(0, 1024);

export const stopOn = (deps: StopDeps): HostStop => {
  const now = deps.now ?? Date.now;
  const holdMs = deps.holdMs ?? STOP_HOLD_MS;
  /** Until when new work is refused; undefined while the host isn't readied to stop. */
  let heldUntil: number | undefined;
  /** One prepare at a time: a second one waits for the first one's pushes. */
  const lock = Semaphore.makeUnsafe(1);

  const stopping = () => {
    if (heldUntil !== undefined && now() >= heldUntil) heldUntil = undefined;
    return heldUntil !== undefined;
  };

  const keep = (checkout: HostStopCheckout, remote: string): Effect.Effect<HostStopKept> =>
    Effect.gen(function* () {
      const base = { threadId: checkout.threadId, cwd: checkout.cwd };
      const refused = yield* (deps.admit?.(checkout.cwd) ?? Effect.void).pipe(
        Effect.as(undefined),
        Effect.catch((error) => Effect.succeed(error.message)),
      );
      if (refused !== undefined) return { ...base, pushed: false, note: note(refused) };
      const snapshot = yield* snapshotWip(checkout.cwd, checkout.threadId).pipe(Effect.result);
      if (snapshot._tag === "Failure")
        return { ...base, pushed: false, note: note(snapshot.failure.message) };
      const kept = { ...base, ref: snapshot.success.ref, commit: snapshot.success.commit };
      const pushed = yield* pushWip(checkout.cwd, snapshot.success, remote).pipe(Effect.result);
      return pushed._tag === "Failure"
        ? { ...kept, pushed: false, note: note(pushed.failure.message) }
        : { ...kept, pushed: true };
    }).pipe(
      // Never a defect: one from a handler breaks the whole connection, not just this call.
      Effect.catchCause(() =>
        Effect.succeed({
          threadId: checkout.threadId,
          cwd: checkout.cwd,
          pushed: false,
          note: "Its work in progress couldn't be kept.",
        }),
      ),
      Effect.provideService(Proc, deps.proc),
    );

  const prepare = (request: StopRequest): Effect.Effect<HostStopPrepared, HostFailed> =>
    Effect.gen(function* () {
      const remote = request.remote ?? "origin";
      if (!isPushRemote(remote))
        return yield* new HostFailed({ message: "That isn't a remote to push to." });
      const force = request.force === true;
      const was = heldUntil;
      // Closed before the look at what runs, so nothing starts between that look and the stop.
      heldUntil = now() + holdMs;
      const busy = yield* deps.busy;
      const updating = deps.admission.closed();
      const inflight = deps.admission.inflight();
      const idle = !isBusy(busy) && inflight === 0 && !updating;
      if (!idle && !force) {
        heldUntil = was;
        return {
          idle,
          busy,
          kept: [],
          ...(updating
            ? { note: "It is updating Gram." }
            : !isBusy(busy)
              ? { note: "It is starting work." }
              : {}),
        };
      }
      // One folder once, whichever threads name it twice.
      const seen = new Set<string>();
      const checkouts = request.checkouts.filter((checkout) => {
        const key = `${checkout.threadId}\0${checkout.cwd}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const kept = yield* Effect.forEach(checkouts, (checkout) => keep(checkout, remote), {
        concurrency: KEEP_CONCURRENCY,
      });
      return { idle, busy, kept };
    });

  return {
    prepare: (request) => lock.withPermits(1)(prepare(request)),
    cancel: Effect.sync(() => {
      heldUntil = undefined;
    }),
    stopping,
  };
};
