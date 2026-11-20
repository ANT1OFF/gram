// The stops of worker machines from a hosted server (`signed-in-workers.ts`): one lock per machine
// name, so a start and a stop of it never overlap, and the stops a server never confirmed, kept
// and asked again until it does.

import { WORKER_MACHINE_NAME } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { KeyedLock } from "../git/keyed-lock.ts";
import { privateJsonFile } from "../http/remote-sessions.ts";
import type { WorkerMachinePortShape } from "./signed-in-port.ts";

/**
 * How long a name is kept after a stop the app didn't answer, before a start of it may go: the
 * app's own call has given up by then (`HOSTED_CALL_MS`, twice for a nonce), but the request may
 * still be on its way to the server.
 */
export const UNANSWERED_STOP_HOLD_MS = 30_000;

/**
 * One lock per machine name: a start and a stop of the same name never overlap, so a stop already
 * on its way is answered before a start of that name goes out, and one that waited for the start
 * sees it took the name. Shared by every source and the settling of stops owed.
 */
export type NameLocks = KeyedLock<string>;

export const withName = <A, E, R>(
  locks: NameLocks | undefined,
  name: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => (locks === undefined ? effect : locks.withLock(name, effect));

/** A server's answer's `code`, where it gives one. */
export const codeOf = (body: unknown): unknown =>
  typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;

/**
 * What a stop's answer says: the machine was stopped; there was no such machine (a 404, or a 2xx
 * saying `stopped: false`, as a server answers a name it holds nothing for); or nothing clear.
 */
export const stopOutcome = (
  answered:
    | { readonly ok: true; readonly status: number; readonly body: unknown }
    | { readonly ok: false },
): "stopped" | "absent" | "failed" => {
  if (!answered.ok) return "failed";
  if (answered.status === 404) return "absent";
  if (answered.status >= 300) return "failed";
  const said =
    typeof answered.body === "object" && answered.body !== null
      ? (answered.body as { stopped?: unknown }).stopped
      : undefined;
  return said === false ? "absent" : "stopped";
};

/**
 * How long after a start whose outcome wasn't known (no answer, or one interrupted on its way) the
 * server's "no such machine" is taken as the end of it: a start still on its way may make the
 * machine after a stop that came first, so until then a 404 settles nothing.
 */
export const UNSETTLED_START_MS = 15 * 60_000;

/**
 * A stop a server never confirmed. `unsettled`: its start's outcome wasn't known when it was owed.
 * `start`: a start's own, written before the start was sent, so one accepted there is given back
 * even if this Gram stops before the machine is registered here; let go once it is. `attempt`:
 * which owing of the name this is, so settling one never lets go of another owed since.
 */
export interface OwedStop {
  readonly origin: string;
  readonly name: string;
  readonly since: number;
  readonly unsettled?: true;
  readonly start?: true;
  readonly attempt?: string;
}

/**
 * The machines a server was asked to stop and never confirmed, with nothing registered here for the
 * release pass to tell it of: asked again every `RECLAIMED_EVERY` until one is, and kept across a
 * restart (`fileOwedStops`).
 */
export interface OwedStops {
  readonly list: () => ReadonlyArray<OwedStop>;
  readonly add: (stop: OwedStop) => void;
  /** Lets go of `name`'s stop owed; with `attempt`, only while that owing is the one kept. */
  readonly remove: (name: string, attempt?: OwedStop) => void;
}

export const memoryOwedStops = (): OwedStops => {
  const owed = new Map<string, OwedStop>();
  return {
    list: () => [...owed.values()],
    add: (stop) => void owed.set(stop.name, stop),
    remove: (name, attempt) => {
      if (attempt === undefined || owed.get(name)?.attempt === attempt.attempt) owed.delete(name);
    },
  };
};

/** `memoryOwedStops` kept in `<dataDir>/remote-access/worker-machine-stops.json`. */
export const fileOwedStops = (dataDir: string): OwedStops => {
  const file = privateJsonFile(dataDir, "worker-machine-stops.json", 64 * 1024);
  const owed = memoryOwedStops();
  try {
    const kept = file.read() as { version?: unknown; owed?: unknown } | undefined;
    if (kept?.version === 1 && Array.isArray(kept.owed))
      for (const each of kept.owed.slice(0, 256))
        if (
          typeof each === "object" &&
          each !== null &&
          typeof each.origin === "string" &&
          typeof each.name === "string" &&
          WORKER_MACHINE_NAME.test(each.name) &&
          Number.isSafeInteger(each.since)
        )
          owed.add({
            origin: each.origin,
            name: each.name,
            since: each.since,
            ...(each.unsettled === true ? { unsettled: true as const } : {}),
            ...(each.start === true ? { start: true as const } : {}),
            ...(typeof each.attempt === "string" && each.attempt.length <= 64
              ? { attempt: each.attempt }
              : {}),
          });
  } catch {
    // An unreadable file owes nothing; the next stop owed writes it again.
  }
  const save = () => {
    try {
      file.write({ version: 1, owed: owed.list() });
    } catch {
      // Kept in memory for this run.
    }
  };
  return {
    list: owed.list,
    add: (stop) => {
      owed.add(stop);
      save();
    },
    remove: (name, attempt) => {
      const before = owed.list().length;
      owed.remove(name, attempt);
      if (owed.list().length !== before) save();
    },
  };
};

/**
 * Asks again for each stop owed; one confirmed is let go, as is one the server knows no more once
 * no start of it can still be on its way. A name this Gram is starting again, or has registered
 * since, is the new start's: that machine is no longer owed a stop (the release pass looks after a
 * registered one), so a debt never stops a retry that took its name.
 */
export const settleOwedStops = (
  port: WorkerMachinePortShape,
  owed: OwedStops,
  claimed: (name: string) => boolean = () => false,
  now: () => number = Date.now,
  locks?: NameLocks,
  /** Names a start of this Gram's is on its way for: a start's own debt is kept while it is. */
  startingNow: (name: string) => boolean = () => false,
) =>
  Effect.gen(function* () {
    for (const stop of owed.list())
      yield* withName(
        locks,
        stop.name,
        Effect.gen(function* () {
          // Looked at again once the name is this pass's alone: a start may have taken it.
          if (claimed(stop.name) || !owed.list().some((each) => each.name === stop.name)) {
            // A start's own, still on its way here: kept, so a restart now still gives it back.
            if (stop.start === true && startingNow(stop.name)) return;
            owed.remove(stop.name, stop);
            return;
          }
          const answered = yield* port.call(stop.origin, "stop", { name: stop.name });
          const outcome = stopOutcome(answered);
          // Unanswered, it may still reach the server: the name is kept a while more.
          if (!answered.ok) yield* Effect.sleep(UNANSWERED_STOP_HOLD_MS);
          // Only what this pass settled: a start owed since, its name's lock waited for, stays.
          if (outcome === "stopped") owed.remove(stop.name, stop);
          else if (
            outcome === "absent" &&
            (stop.unsettled !== true || now() - stop.since >= UNSETTLED_START_MS)
          )
            owed.remove(stop.name, stop);
        }),
      );
  });
