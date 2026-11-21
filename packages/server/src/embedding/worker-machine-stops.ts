import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

import { WORKER_MACHINE_NAME } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { KeyedLock } from "../git/keyed-lock.ts";
import { privateJsonFile } from "../http/remote-sessions.ts";
import { fenceRefusalOf } from "./signed-in-fences.ts";
import type { WorkerMachinePortShape } from "./signed-in-port.ts";

/**
 * How long a name is kept after a stop the app didn't answer, before a start of it may go: the
 * app's own call has given up by then (`HOSTED_CALL_MS`, twice for a nonce), but the request may
 * still be on its way to the server.
 */
export const UNANSWERED_STOP_HOLD_MS = 30_000;

/** How long the app is given to answer a call (`signed-in-port.ts`): a stop's reply comes by then. */
export const STOP_CALL_MS = 45_000;

/**
 * The latest a stop asked for at `sentAt` may leave the app (`WorkerMachineOp`'s `sendBy`): its
 * last request then has the app's own call time to land, all within `STOP_CALL_MS`.
 */
export const stopSendBy = (sentAt: number) => sentAt + 30_000;

const STOP_REQUEST_MS = 15_000;

/**
 * How long a hosted server may still act on a stop it has taken: its call down to the workspace's
 * backend may wait up to 120 s, and the stop then waits up to 10 s for the person's lock. Past that
 * only the server can say (a stop that carried its own expiry, or named the disk it meant).
 */
export const SERVER_ACTS_WITHIN_MS = 120_000 + 10_000;

/**
 * How long a stop sent of a name holds it, from when it is asked for: until the last time it may
 * leave the app (`stopSendBy`, 30 s), its request's own time (15 s), the time the server may take
 * to act on it (`SERVER_ACTS_WITHIN_MS`, 130 s), and `UNANSWERED_STOP_HOLD_MS` (30 s) besides as a
 * margin: 205 s in all.
 */
export const STOP_HOLD_MS =
  stopSendBy(0) + STOP_REQUEST_MS + SERVER_ACTS_WITHIN_MS + UNANSWERED_STOP_HOLD_MS;

/**
 * Until when a stop asked for at `sentAt` may still act there (`STOP_HOLD_MS`). Kept with the
 * stops owed, across a restart, and let go only by that stop's own answer: no start of the name is
 * sent before then (`StopHolds`).
 */
export const stopHoldUntil = (sentAt: number) => sentAt + STOP_HOLD_MS;

/**
 * The latest a stop asked for at `sentAt` may act there (its `notAfter`): when it may last leave
 * the app, its request's time and the server's (`SERVER_ACTS_WITHIN_MS`), 175 s, inside the name's
 * hold by `UNANSWERED_STOP_HOLD_MS`, which is left for the two clocks to differ. Reached later, the
 * server does nothing (`expired`), so no stop ever lands after the hold lets a start of it go.
 */
export const stopNotAfter = (sentAt: number) => stopHoldUntil(sentAt) - UNANSWERED_STOP_HOLD_MS;

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

/**
 * Whether a stop's answer settles whether it can still act there: any answer below 500. No
 * answer, or a 5xx (a 503 included: the server's own call down may have broken after it went
 * out), leaves it free to act later, so its hold stays its full time.
 */
export const stopSettled = (
  answered: { readonly ok: true; readonly status: number } | { readonly ok: false },
) => answered.ok && answered.status < 500;

/** A server's answer's `code`, where it gives one. */
export const codeOf = (body: unknown): unknown =>
  typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;

/**
 * Whether an answer is a `404 { code: "not_found" }`, the one a server gives a name it doesn't
 * know. Alone it proves nothing: the server answers the same while it has no backend, or the
 * workspace no backend, for a while. Only `RECLAIMED_AFTER_MISSES` of them in a row, asked a pass
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
 * What a stop's answer says: the machine was stopped; its fence held it back (`fenced`: it came
 * after its `notAfter`, or the name is now another run, so nothing was done and it is asked again,
 * never taken as no such machine); there was no such machine (a 2xx saying
 * `stopped: false`, as a server answers a name it holds nothing for, under its person's lock);
 * `missing`, a `404 not_found`, which says so only once it comes a few passes in a row
 * (`isNotFound`); or nothing clear.
 */
export const stopOutcome = (
  answered:
    | { readonly ok: true; readonly status: number; readonly body: unknown }
    | { readonly ok: false },
): "stopped" | "fenced" | "absent" | "missing" | "failed" => {
  if (!answered.ok) return "failed";
  if (isNotFound(answered)) return "missing";
  if (answered.status >= 300) return "failed";
  if (fenceRefusalOf(answered) !== undefined) return "fenced";
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
  /**
   * The sign-in it was owed under (`WorkerMachineServer.account`): asked again, and settled, only
   * under it.
   */
  readonly account?: string;
  /**
   * Read back from before sign-ins were kept: whose it is isn't known, so only a stop answered
   * done settles it, never a "no such machine", which another sign-in may be answering.
   */
  readonly legacy?: true;
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
  /**
   * Lets go of every owing of `name` on the server at `origin` made under the sign-in `account`
   * (`ownsOwing`), and of no other: another sign-in's, or one from before sign-ins were kept,
   * stays.
   */
  readonly release: (origin: string, name: string, account: string | undefined) => void;
  /** The holds of stops on their way (`stopHoldUntil`), kept beside what is owed. */
  readonly holds: StopHolds;
  /**
   * Moves every owing on `origin` under the sign-in mark `from` to `to`, in one write: the same
   * sign-in, whose mark became its organisation's. No other owing changes. Whether what is owed
   * is on disk after it: a write that failed is tried again by the next move asked for, and one
   * lost to a restart is made again as the app tells the former marks at the next start.
   */
  readonly remark: (origin: string, from: string, to: string) => boolean;
}

/**
 * The stops sent that may still reach a server, by name and server: each held from before it is
 * sent until its own answer comes, or its time is up. A start of the name waits until none is.
 */
export interface StopHolds {
  /**
   * Holds `name` on `origin` until `until`, for one stop: its id, or nothing when the hold
   * couldn't be written down, and then the stop isn't sent.
   */
  readonly hold: (origin: string, name: string, until: number) => string | undefined;
  /** That stop's own answer came: its hold, and no other, is let go. */
  readonly answered: (id: string) => void;
  /** The latest time any stop of `name` on `origin` holds it to, if one still does. */
  readonly until: (origin: string, name: string, now: number) => number | undefined;
}

interface StopHold {
  readonly id: string;
  readonly origin: string;
  readonly name: string;
  readonly until: number;
}

const memoryStopHolds = (
  kept: ReadonlyArray<StopHold>,
  changed: () => boolean,
  now: () => number,
) => {
  const holds = new Map(kept.map((each) => [each.id, each]));
  let next = 0;
  const prune = () => {
    const at = now();
    for (const [id, each] of holds) if (each.until <= at) holds.delete(id);
  };
  return {
    list: () => {
      prune();
      return [...holds.values()];
    },
    holds: {
      hold: (origin: string, name: string, until: number) => {
        prune();
        const id = `${Date.now().toString(36)}-${(next += 1)}-${Math.random().toString(36).slice(2, 8)}`;
        holds.set(id, { id, origin, name, until });
        if (changed()) return id;
        holds.delete(id);
        return undefined;
      },
      answered: (id: string) => {
        if (holds.delete(id)) changed();
      },
      until: (origin: string, name: string, at: number) => {
        let latest: number | undefined;
        for (const [id, each] of holds) {
          if (each.until <= at) holds.delete(id);
          else if (each.origin === origin && each.name === name)
            latest = Math.max(latest ?? 0, each.until);
        }
        return latest;
      },
    } satisfies StopHolds,
  };
};

/**
 * Whether `each` is an owing of `name` on `origin` made under the sign-in `account`: one from
 * before sign-ins were kept is no one's known, and so never matches.
 */
export const ownsOwing = (
  each: OwedStop,
  origin: string,
  name: string,
  account: string | undefined,
) =>
  each.origin === origin && each.name === name && each.legacy !== true && each.account === account;

/** The most stops kept owed at once: a start that would need one more is refused. */
export const OWED_MOST = 256;

const owingOf = (stop: OwedStop) => stop.attempt ?? `${stop.name}@${stop.since}`;

export const memoryOwedStops = (
  kept: ReadonlyArray<StopHold> = [],
  changed: () => boolean = () => true,
  now: () => number = Date.now,
): OwedStops & { readonly heldList: () => ReadonlyArray<StopHold> } => {
  const owed = new Map<string, OwedStop>();
  const held = memoryStopHolds(kept, changed, now);
  return {
    holds: held.holds,
    heldList: held.list,
    list: () => [...owed.values()],
    add: (stop) => {
      if (!owed.has(owingOf(stop))) owed.set(owingOf(stop), stop);
    },
    admit: (stop) => {
      if (owed.size >= OWED_MOST) return false;
      if (!owed.has(owingOf(stop))) owed.set(owingOf(stop), stop);
      return true;
    },
    release: (origin, name, account) => {
      for (const [key, each] of owed) if (ownsOwing(each, origin, name, account)) owed.delete(key);
    },
    remark: (origin, from, to) => {
      for (const [key, each] of owed)
        if (each.origin === origin && each.legacy !== true && each.account === from)
          owed.set(key, { ...each, account: to });
      return true;
    },
    remove: (name, attempt) => {
      if (attempt !== undefined) owed.delete(owingOf(attempt));
      else for (const [key, each] of owed) if (each.name === name) owed.delete(key);
    },
  };
};

/** The most the stops owed file may hold, as it is read back: no more is ever written. */
export const STOPS_FILE_MOST = 512 * 1024;

const STOPS_FILE_READ_MOST = 16 * 1024 * 1024;

/** `memoryOwedStops` kept in `<dataDir>/remote-access/worker-machine-stops.json`. */
export const fileOwedStops = (dataDir: string, now: () => number = Date.now): OwedStops => {
  const file = privateJsonFile(dataDir, "worker-machine-stops.json", STOPS_FILE_MOST);
  let read: { version?: unknown; owed?: unknown; holds?: unknown } | undefined;
  let keepFile = false;
  let remarkUnsaved = false;
  try {
    read = privateJsonFile(
      dataDir,
      "worker-machine-stops.json",
      STOPS_FILE_READ_MOST,
    ).read() as typeof read;
  } catch {
    read = undefined;
    const path = join(dataDir, "remote-access", "worker-machine-stops.json");
    try {
      if (existsSync(path)) renameSync(path, `${path}.unreadable-${Date.now()}`);
    } catch {
      keepFile = true;
    }
  }
  const readAt = now();
  const keptHolds = (Array.isArray(read?.holds) ? (read.holds as unknown[]) : []).flatMap(
    (each): StopHold[] =>
      typeof each === "object" &&
      each !== null &&
      typeof (each as StopHold).id === "string" &&
      typeof (each as StopHold).origin === "string" &&
      typeof (each as StopHold).name === "string" &&
      Number.isSafeInteger((each as StopHold).until)
        ? [
            {
              ...(each as StopHold),
              until: Math.min((each as StopHold).until, readAt + STOP_HOLD_MS),
            },
          ]
        : [],
  );
  const owed = memoryOwedStops(keptHolds, () => save(), now);
  try {
    const kept = read;
    if (kept?.version === 1 && Array.isArray(kept.owed))
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
            ...(typeof each.account === "string" && each.account.length <= 64
              ? { account: each.account }
              : {}),
            ...(each.legacy === true || (each.account === undefined && each.noAccount !== true)
              ? { legacy: true as const }
              : {}),
          });
  } catch (_anOwingThatCantBeReadIsLeftOut) {}
  function save() {
    if (keepFile) return false;
    try {
      const value = {
        version: 1,
        owed: owed
          .list()
          .map((each) =>
            each.account === undefined && each.legacy !== true
              ? { ...each, noAccount: true }
              : each,
          ),
        holds: owed.heldList(),
      };
      if (Buffer.byteLength(JSON.stringify(value)) > STOPS_FILE_MOST) return false;
      file.write(value);
      remarkUnsaved = false;
      return true;
    } catch {
      return false;
    }
  }
  return {
    holds: owed.holds,
    list: owed.list,
    add: (stop) => {
      owed.add(stop);
      save();
    },
    admit: (stop) => {
      if (!owed.admit(stop)) return false;
      if (save()) return true;
      owed.remove(stop.name, stop);
      return false;
    },
    remark: (origin, from, to) => {
      const moved = owed
        .list()
        .some((each) => each.origin === origin && each.legacy !== true && each.account === from);
      owed.remark(origin, from, to);
      if (moved || remarkUnsaved) remarkUnsaved = !save();
      return !remarkUnsaved;
    },
    release: (origin, name, account) => {
      const before = owed.list().length;
      owed.release(origin, name, account);
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
  claimed: (name: string, origin: string, stop: OwedStop) => boolean | "other" = () => false,
  now: () => number = Date.now,
  locks?: NameLocks,
  startingNow: (name: string) => boolean = () => false,
  misses: Map<string, number> = new Map(),
) =>
  Effect.gen(function* () {
    for (const stop of owed.list())
      yield* withName(
        locks,
        stop.name,
        Effect.gen(function* () {
          if (!owed.list().some((each) => owingOf(each) === owingOf(stop))) return;
          if (startingNow(stop.name)) return;
          const held = claimed(stop.name, stop.origin, stop);
          if (held === "other") return;
          if (held) {
            owed.remove(stop.name, stop);
            return;
          }
          const sentAt = now();
          const hold = owed.holds.hold(stop.origin, stop.name, stopHoldUntil(sentAt));
          if (hold === undefined) return;
          const answered = yield* port.call(
            stop.origin,
            "stop",
            { name: stop.name, notAfter: stopNotAfter(sentAt) },
            { sendBy: stopSendBy(sentAt), account: stop.account },
          );
          if (stopSettled(answered)) owed.holds.answered(hold);
          const outcome = stopOutcome(answered);
          const key = owingOf(stop);
          const missed = outcome === "missing" ? (misses.get(key) ?? 0) + 1 : 0;
          if (missed === 0) misses.delete(key);
          else misses.set(key, missed);
          const absent =
            stop.legacy !== true &&
            (outcome === "absent" || (outcome === "missing" && missed >= RECLAIMED_AFTER_MISSES));
          if (outcome === "stopped") owed.remove(stop.name, stop);
          else if (absent && (stop.unsettled !== true || now() - stop.since >= UNSETTLED_START_MS))
            owed.remove(stop.name, stop);
          if (!owed.list().some((each) => owingOf(each) === key)) misses.delete(key);
        }),
      );
  });
