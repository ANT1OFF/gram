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
 * Whether an answer is a `404 { code: "not_found" }`, the one a server gives a name it doesn't
 * know. Alone it proves nothing: the server answers the same while it has no cell manager, or the
 * workspace no cell, for a while. Only `RECLAIMED_AFTER_MISSES` of them in a row, asked a pass
 * apart, are taken as the machine gone; any other 404 is a passing error.
 */
export const isNotFound = (
  answered:
    | { readonly ok: true; readonly status: number; readonly body: unknown }
    | { readonly ok: false },
) => answered.ok && answered.status === 404 && codeOf(answered.body) === "not_found";

/** How many passes in a row a machine is answered `isNotFound` before it is taken as gone. */
export const RECLAIMED_AFTER_MISSES = 3;

/**
 * What a stop's answer says: the machine was stopped; there was no such machine (a 2xx saying
 * `stopped: false`, as a server answers a name it holds nothing for, under its person's lock);
 * `missing`, a `404 not_found`, which says so only once it comes a few passes in a row
 * (`isNotFound`); or nothing clear.
 */
export const stopOutcome = (
  answered:
    | { readonly ok: true; readonly status: number; readonly body: unknown }
    | { readonly ok: false },
): "stopped" | "absent" | "missing" | "failed" => {
  if (!answered.ok) return "failed";
  if (isNotFound(answered)) return "missing";
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
  /**
   * Kept beside every other owing: one per attempt (name, server and attempt id), each until it
   * is settled, so what is owed is the whole of what may still be there. Kept as it is when that
   * attempt is owed already.
   */
  readonly add: (stop: OwedStop) => void;
  /**
   * `add`, in one step, only while fewer than `OWED_MOST` are owed: whether it was kept. A start
   * is admitted so, never sent unless its stop is owed first.
   */
  readonly admit: (stop: OwedStop) => boolean;
  /**
   * With `attempt`, lets go of that owing alone; without, of every owing of `name` (its machine is
   * registered here, or confirmed stopped under its name's lock).
   */
  readonly remove: (name: string, attempt?: OwedStop) => void;
  /** Lets go of every owing of `name` on the server at `origin`, and on no other. */
  readonly release: (origin: string, name: string) => void;
}

/** The most stops kept owed at once: a start that would need one more is refused. */
export const OWED_MOST = 256;

/** Which owing a stop is: its attempt id, or, for one kept before ids, its name and time. */
const owingOf = (stop: OwedStop) => stop.attempt ?? `${stop.name}@${stop.since}`;

export const memoryOwedStops = (): OwedStops => {
  const owed = new Map<string, OwedStop>();
  return {
    list: () => [...owed.values()],
    add: (stop) => {
      if (!owed.has(owingOf(stop))) owed.set(owingOf(stop), stop);
    },
    admit: (stop) => {
      if (owed.size >= OWED_MOST) return false;
      if (!owed.has(owingOf(stop))) owed.set(owingOf(stop), stop);
      return true;
    },
    release: (origin, name) => {
      for (const [key, each] of owed)
        if (each.name === name && each.origin === origin) owed.delete(key);
    },
    remove: (name, attempt) => {
      if (attempt !== undefined) owed.delete(owingOf(attempt));
      else for (const [key, each] of owed) if (each.name === name) owed.delete(key);
    },
  };
};

/** `memoryOwedStops` kept in `<dataDir>/remote-access/worker-machine-stops.json`. */
export const fileOwedStops = (dataDir: string): OwedStops => {
  // Room for every stop that may be owed (`OWED_MOST`), long origins included: one past it, or a
  // file too large to read, would lose them all.
  const file = privateJsonFile(dataDir, "worker-machine-stops.json", 512 * 1024);
  const owed = memoryOwedStops();
  try {
    const kept = file.read() as { version?: unknown; owed?: unknown } | undefined;
    if (kept?.version === 1 && Array.isArray(kept.owed))
      // Every owing kept, however many: one is never left out on reading. Past `OWED_MOST`, no
      // start is admitted until enough are settled.
      for (const each of kept.owed)
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
  /** Whether what is owed is on disk now. A write that failed keeps it in memory for this run. */
  const save = () => {
    try {
      file.write({ version: 1, owed: owed.list() });
      return true;
    } catch {
      return false;
    }
  };
  return {
    list: owed.list,
    add: (stop) => {
      owed.add(stop);
      save();
    },
    // Admitted only once it is on disk: a start owed in memory alone would be lost on a restart.
    admit: (stop) => {
      if (!owed.admit(stop)) return false;
      if (save()) return true;
      owed.remove(stop.name, stop);
      return false;
    },
    release: (origin, name) => {
      const before = owed.list().length;
      owed.release(origin, name);
      if (owed.list().length !== before) save();
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
 * no start of it can still be on its way: said so (`stopped: false`), or answered `404 not_found`
 * on `RECLAIMED_AFTER_MISSES` passes in a row (`misses`, by owing, kept across passes). A name this
 * Gram is starting again, or has registered since, is the new start's: that machine is no longer
 * owed a stop (the release pass looks after a registered one), so a debt never stops a retry that
 * took its name.
 */
export const settleOwedStops = (
  port: WorkerMachinePortShape,
  owed: OwedStops,
  claimed: (name: string, origin: string) => boolean = () => false,
  now: () => number = Date.now,
  locks?: NameLocks,
  /** Names a start of this Gram's is on its way for: a start's own debt is kept while it is. */
  startingNow: (name: string) => boolean = () => false,
  misses: Map<string, number> = new Map(),
) =>
  Effect.gen(function* () {
    for (const stop of owed.list())
      yield* withName(
        locks,
        stop.name,
        Effect.gen(function* () {
          // Looked at again once the name is this pass's alone. A start of it on its way here:
          // every owing of it is kept, so a refusal of that start, or a restart, still gives the
          // machine back. Taken since (registered here): let go, the release pass has it.
          if (!owed.list().some((each) => owingOf(each) === owingOf(stop))) return;
          if (startingNow(stop.name)) return;
          if (claimed(stop.name, stop.origin)) {
            owed.remove(stop.name, stop);
            return;
          }
          const answered = yield* port.call(stop.origin, "stop", { name: stop.name });
          const outcome = stopOutcome(answered);
          const key = owingOf(stop);
          const missed = outcome === "missing" ? (misses.get(key) ?? 0) + 1 : 0;
          if (missed === 0) misses.delete(key);
          else misses.set(key, missed);
          // Unanswered, it may still reach the server: the name is kept a while more.
          if (!answered.ok) yield* Effect.sleep(UNANSWERED_STOP_HOLD_MS);
          const absent =
            outcome === "absent" || (outcome === "missing" && missed >= RECLAIMED_AFTER_MISSES);
          // Only what this pass settled: a start owed since, its name's lock waited for, stays.
          if (outcome === "stopped") owed.remove(stop.name, stop);
          else if (absent && (stop.unsettled !== true || now() - stop.since >= UNSETTLED_START_MS))
            owed.remove(stop.name, stop);
          if (!owed.list().some((each) => owingOf(each) === key)) misses.delete(key);
        }),
      );
  });
