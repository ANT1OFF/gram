// One worker machine's calls to a hosted server (`signed-in-workers.ts`): its status as read, a
// start of its name (a release taken back, a `503` asked again a few times), a wake of one that is
// stopped or failed there, and a release told.

import * as Effect from "effect/Effect";
import type { Refused, WorkerMachinePortShape } from "./signed-in-port.ts";
import { codeOf, isNotFound, type NameLocks, withName } from "./worker-machine-stops.ts";

/** How many times a start the server is unavailable for (`503`) is asked, and the first wait. */
export const START_ATTEMPTS = 3;
const START_RETRY_MS = 2_000;

const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const PLATFORM = /^[a-z0-9]{1,16}$/;

/** A server's `…/status` answer as this reads it: its phase, a line, and the host's key once made. */
export const parseMachineStatus = (
  value: unknown,
): {
  readonly phase?: string;
  readonly message?: string;
  readonly publicKey?: string;
  readonly platform?: string;
} => {
  if (typeof value !== "object" || value === null) return {};
  const body = value as Record<string, unknown>;
  const line = (field: string, most: number) => {
    const each = body[field];
    return typeof each === "string" && each.length <= most && !/[\0\n\r]/.test(each)
      ? each
      : undefined;
  };
  const phase = line("phase", 24);
  const message = line("message", 300);
  const publicKey = line("publicKey", 64);
  const platform = line("platform", 16);
  return {
    ...(phase === undefined ? {} : { phase }),
    ...(message === undefined ? {} : { message }),
    ...(publicKey !== undefined && PUBLIC_KEY.test(publicKey) ? { publicKey } : {}),
    ...(platform !== undefined && PLATFORM.test(platform) ? { platform } : {}),
  };
};

/** A worker machine's name as a hosted server takes it: `worker-` and ten hex digits. */
const HOSTED_WORKER_NAME = /^worker-[0-9a-f]{10}$/;
export const isHostedWorkerName = (name: string) => HOSTED_WORKER_NAME.test(name);

type Answered = { readonly ok: true; readonly status: number; readonly body: unknown } | Refused;

/**
 * Each name's starts, counted once as each is sent and once as it is answered (or given up on), so
 * an odd count is a start on its way. A `…/status` answer is read only when no start of its name was
 * on its way, sent or answered while it was asked (`settledSince`): one asked before a start, or
 * while one was outstanding, is older than that start, and says nothing.
 */
export type StartsSent = Map<string, number>;

export const sentOf = (sent: StartsSent | undefined, name: string) => sent?.get(name) ?? 0;

/** Whether a status asked for when the count was `before` is still the machine's: see above. */
export const settledSince = (sent: StartsSent | undefined, name: string, before: number) =>
  before % 2 === 0 && sentOf(sent, name) === before;

/**
 * One start of `name` there, its name's alone (`withName`) from its first ask to its last. A `503`
 * started nothing, so it is asked again after a wait that doubles, `START_ATTEMPTS` asks in all
 * across the whole start, and is never read as over the total or gone. A `409 released` takes the
 * release back and asks once more, never again; a take-back the server answers `404 not_found`
 * (the release is due for reclaim) spends the name for this start, answered as `409 name_in_use`,
 * and nothing more is asked under it. Nothing here forgets the machine: once is no proof. `go`, read under the lock before each ask: whether it is still wanted; when it isn't,
 * nothing more is sent (`skipped`).
 */
export const sendSignedInStart = (
  port: WorkerMachinePortShape,
  origin: string,
  name: string,
  body: Readonly<Record<string, unknown>>,
  options: {
    readonly locks?: NameLocks | undefined;
    readonly startRetryMs?: number | undefined;
    readonly sent?: StartsSent | undefined;
    readonly go?: (() => boolean) | undefined;
    /**
     * Run once the name is this start's alone, before anything is sent: an answer it gives is
     * the start's, and nothing is sent.
     */
    readonly onLocked?: (() => Answered | undefined) | undefined;
  },
): Effect.Effect<{
  readonly answered: Answered;
  readonly unavailable: boolean;
  readonly skipped?: true;
}> =>
  withName(
    options.locks,
    name,
    Effect.gen(function* () {
      const admitted = options.onLocked?.();
      if (admitted !== undefined) return { answered: admitted, unavailable: false };
      let unavailable = false;
      let asks = 0;
      const skipped = {
        answered: { ok: false as const, why: "no longer wanted" },
        unavailable: false,
        skipped: true as const,
      };
      const send = Effect.gen(function* () {
        for (;;) {
          if (options.go !== undefined && !options.go()) return undefined;
          asks += 1;
          const bump = Effect.sync(() => options.sent?.set(name, sentOf(options.sent, name) + 1));
          yield* bump;
          const answered = yield* port.call(origin, "start", body).pipe(Effect.ensuring(bump));
          // Busy (503) or throttled (429) there: asked again after a wait. A 503 may have reached
          // its machines, so the start's outcome stays unknown, whatever is answered after it.
          const busy = answered.ok && (answered.status === 503 || answered.status === 429);
          if (answered.ok && answered.status === 503) unavailable = true;
          if (!busy || asks >= START_ATTEMPTS) return answered;
          yield* Effect.sleep((options.startRetryMs ?? START_RETRY_MS) * 2 ** (asks - 1));
        }
      });
      const first = yield* send;
      if (first === undefined) return skipped;
      if (!first.ok || first.status !== 409 || codeOf(first.body) !== "released")
        return { answered: first, unavailable };
      const told = yield* tellSignedInRelease(port, { name, via: origin }, false).pipe(
        Effect.option,
      );
      if (told._tag === "Some" && told.value === "missing")
        return {
          answered: { ok: true as const, status: 409, body: { code: "name_in_use" } },
          unavailable: false,
        };
      // Asked once more, within what is left of the asks.
      if (asks >= START_ATTEMPTS) asks = START_ATTEMPTS - 1;
      const second = yield* send;
      if (second === undefined) return skipped;
      return { answered: second, unavailable };
    }),
  );

/**
 * What a wake did. `started`, `awake` (the server says it is up, or starting), `gone` (it answers
 * `404 not_found`: not woken for this want, and not forgotten either), `unwanted` (no one wants it by the time the start would go) and `refused` (an answered
 * refusal) are settled; `retry` isn't: no answer, or a passing error, before or from the start, so
 * it may be woken again while it is still wanted.
 */
export type WakeOutcome = "started" | "awake" | "gone" | "unwanted" | "refused" | "retry";

/**
 * Wakes a worker machine that work here wants (a session about to open on it: a worker resumed,
 * or a message to one), when its server says it is stopped or failed: no dial wakes it there, only
 * a start of its name, which takes it back on its own disk. The start is the spawn's (the name's
 * lock, a release taken back first, a `503` asked again a few times): `{name}` alone, since the
 * server keeps what it was started with. Never on a dial, and never for one it doesn't say is
 * stopped or failed, so a name it doesn't know is never started afresh.
 */
export const wakeSignedIn = (
  port: WorkerMachinePortShape,
  machine: { readonly name: string; readonly via: string },
  options: {
    readonly locks?: NameLocks | undefined;
    readonly startRetryMs?: number | undefined;
    /** Names not relayed while asleep: a wake that started one relays it again. */
    readonly asleep?: Set<string> | undefined;
    readonly sent?: StartsSent | undefined;
    /** Whether work here still wants it, read as the start would go: none is sent once not. */
    readonly wanted?: (() => boolean) | undefined;
  } = {},
): Effect.Effect<WakeOutcome> =>
  Effect.gen(function* () {
    if (!isHostedWorkerName(machine.name)) return "refused" as const;
    const before = sentOf(options.sent, machine.name);
    const read = yield* port.call(machine.via, "status", { name: machine.name });
    // Passing errors settle nothing: asked again while it is still wanted.
    if (!read.ok || read.status >= 500 || read.status === 429) return "retry" as const;
    if (isNotFound(read)) return "gone" as const;
    // Any other 404 (a route or a cell not there for now) says nothing of the machine.
    if (read.status === 404) return "retry" as const;
    if (read.status >= 300) return "refused" as const;
    // A start of it was on its way, or went, while this was asked: the answer is older than it,
    // and says nothing, so the wake is left to be tried again rather than spent.
    if (!settledSince(options.sent, machine.name, before)) return "retry" as const;
    const phase = parseMachineStatus(read.body).phase;
    if (phase !== "stopped" && phase !== "failed") {
      options.asleep?.delete(machine.name);
      return "awake" as const;
    }
    const sent = yield* sendSignedInStart(
      port,
      machine.via,
      machine.name,
      { name: machine.name },
      { ...options, go: options.wanted },
    );
    if (sent.skipped === true) return "unwanted" as const;
    const answered = sent.answered;
    if (answered.ok && answered.status >= 200 && answered.status < 300) {
      options.asleep?.delete(machine.name);
      return "started" as const;
    }
    if (!answered.ok || answered.status >= 500 || answered.status === 429) return "retry" as const;
    // Only the status: what a server answers isn't written to the log.
    yield* Effect.logWarning("a worker machine work wants could not be woken").pipe(
      Effect.annotateLogs({
        machine: machine.name,
        reason: answered.ok ? `answered ${answered.status}` : "no answer",
      }),
    );
    return "refused" as const;
  });

/**
 * Tells a signed-in server a worker machine's work is over, or going on again. `missing`: answered
 * `404 not_found`, which a server says of a machine it reclaimed, but also for a while of every
 * machine while it has no cell manager or the workspace no cell: never taken as the machine gone
 * (`isNotFound`). Any other 404 is asked again, as a busy server is.
 */
export const tellSignedInRelease = (
  port: WorkerMachinePortShape,
  machine: { readonly name: string; readonly via: string },
  released: boolean,
  options: { readonly retryMs?: number; readonly attempts?: number } = {},
): Effect.Effect<"applied" | "missing", Error> =>
  Effect.gen(function* () {
    const attempts = options.attempts ?? RELEASE_ATTEMPTS;
    let last = "no answer";
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      // A server too busy, or no answer: asked again after a wait that doubles.
      if (attempt > 0)
        yield* Effect.sleep((options.retryMs ?? RELEASE_RETRY_MS) * 2 ** (attempt - 1));
      const answered = yield* port.call(machine.via, "release", {
        name: machine.name,
        released,
        reason: released ? "finished" : "working",
      });
      if (!answered.ok) {
        last = "no answer";
        continue;
      }
      if (isNotFound(answered)) return "missing" as const;
      if (answered.status === 503 || answered.status === 404) {
        last = answered.status === 503 ? "the server is busy" : "the server answered 404";
        continue;
      }
      if (answered.status >= 300)
        return yield* Effect.fail(new Error(`the server answered ${answered.status}`));
      // A 2xx that says it knows no such machine changed nothing there: told again next pass.
      const known =
        typeof answered.body === "object" && answered.body !== null
          ? (answered.body as { known?: unknown }).known
          : undefined;
      if (known === false) return yield* Effect.fail(new Error("the server knows no such machine"));
      return "applied" as const;
    }
    // Only what went wrong, in a few words: what a server answers isn't written to the log.
    return yield* Effect.fail(new Error(last));
  });

/** How many times a release is asked while the server is busy, and the first wait between. */
export const RELEASE_ATTEMPTS = 3;
export const RELEASE_RETRY_MS = 1_000;
