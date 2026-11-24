import type { ConnectorsSeen, SequencedEvent } from "@gram/agents";
import { HostFailed, type HostSessionOpen, type HostUnavailable } from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { HostConnection, HostSessionsConnection } from "./protocol.ts";
import { GOING_WITHIN_MS } from "./term-hold.ts";

/**
 * How long a session on a joined machine waits for the machine to dial in again after its
 * connection dropped, before it counts as ended with it. Less than the host's own
 * `DETACHED_GRACE_MS`, so the host still has it when this side gives up.
 */
export const REATTACH_WITHIN_MS = 2 * 60_000;
/**
 * How long a session waits instead for a machine this Gram readied to stop (`stop-resume.ts`):
 * its turn was cut by a stop that couldn't wait for it, and goes on once a host is started on the
 * machine's disk again.
 */
export const STOPPED_REATTACH_MS = 15 * 60_000;
/**
 * How long a call into a session (an answer, a mode) waits for the machine to be back. Its input
 * waits as long as the session does (`REATTACH_WITHIN_MS`).
 */
export const CALL_WAIT_MS = 15_000;
const LOOK_EVERY = "500 millis";
/**
 * How long a session waits for its machine to come back while the machine is being replaced (a
 * cloud machine reclaimed, a VM moved) and is expected back on the same disk, unless whoever runs it
 * says otherwise (`POST /machines/stop/moving`) or `GRAM_MACHINE_MOVE_MINUTES` does.
 */
export const MOVE_WITHIN_MS = 20 * 60_000;
/**
 * How long an agent's end that its host passed on is held to see whether the host is going with it:
 * a host stopped with its whole process group (a service restart, a machine shutting down) can
 * pass on its agent's end, killed by the same signal, before its own connection closes.
 */
export const ENDED_SETTLE_MS = 2_000;
/**
 * As `ENDED_SETTLE_MS`, for a machine being replaced: its host holds its exit while this Gram keeps
 * its work (`GOING_WITHIN_MS`), and its agents end as it then shuts down.
 */
export const MOVE_GONE_WITHIN_MS = GOING_WITHIN_MS + 30_000;
const GONE_LOOK = "100 millis";

/** The machine's connection once it is back, or `HostUnavailable` when it isn't within `ms`. */
export const awaitConnection = (
  connection: Effect.Effect<HostConnection, HostUnavailable>,
  ms: number,
): Effect.Effect<HostConnection, HostUnavailable> =>
  connection.pipe(
    Effect.retry(
      Schedule.spaced(LOOK_EVERY).pipe(Schedule.upTo({ duration: Duration.millis(ms) })),
    ),
  );

/**
 * A joined machine's sessions as one connection that outlives its dials. Each call goes to the
 * machine's connection now, waiting `callMs` for it to dial in again after a drop. Each session's
 * events follow it across a redial: once the old stream fails with the connection, the next one
 * picks up after the last event received, from the events the host kept. Only a machine that
 * doesn't come back within `reattachMs` ends its sessions here, and a host that no longer has a
 * session (it restarted) ends it with `NotFound`, as before.
 */
export const followingSessions = (
  current: Effect.Effect<HostConnection, HostUnavailable>,
  timing: {
    /** Read at each wait, so a machine readied to stop meanwhile is waited for as one. */
    readonly reattachMs?: number | (() => number);
    readonly callMs?: number;
    /**
     * Asked of each open against the connection it goes to, just before it is sent there: why it
     * mustn't open now, if it mustn't. What let the session through was asked of the machine as
     * it was then; a machine that came back on another disk meanwhile owes a resume first.
     */
    readonly admit?: (request: HostSessionOpen) => string | undefined;
    /**
     * Read at each wait: how long a session waits for the machine because it is being replaced and
     * is expected back (its host said it was going, this Gram readied it to stop, or whoever runs it
     * said it was moving), or undefined when it isn't. A session that waits for a move says so with
     * a `machineMoving` event, and `moved` then answers for it.
     */
    readonly moving?: () => number | undefined;
    /**
     * Runs a wait for the machine's move as one that wants the machine, so whoever runs it starts
     * it again if it is stopped (`StopMarks.wanting`).
     */
    readonly wanting?: <A, E>(wait: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  } = {},
): HostSessionsConnection => {
  const reattach = timing.reattachMs ?? REATTACH_WITHIN_MS;
  const reattachOf = () => (typeof reattach === "number" ? reattach : reattach());
  const callMs = timing.callMs ?? CALL_WAIT_MS;
  const sessions = awaitConnection(current, callMs).pipe(
    Effect.map((connection) => connection.sessions),
  );
  const call = <A, E>(
    run: (sessions: HostSessionsConnection) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | HostFailed> =>
    sessions.pipe(
      Effect.mapError((error) => new HostFailed({ message: error.message })),
      Effect.flatMap(run),
    );
  const deliver = (
    deliveryId: string | undefined,
    run: (sessions: HostSessionsConnection) => Effect.Effect<void, HostFailed>,
  ): Effect.Effect<void, HostFailed> =>
    deliveryId === undefined
      ? call(run)
      : Effect.gen(function* () {
          const until = (yield* Clock.currentTimeMillis) + reattachOf();
          for (;;) {
            const left = until - (yield* Clock.currentTimeMillis);
            const live = yield* awaitConnection(current, Math.max(0, left)).pipe(
              Effect.mapError((error) => new HostFailed({ message: error.message })),
            );
            const exit = yield* Effect.exit(run(live.sessions));
            if (Exit.isSuccess(exit)) return;
            const again =
              live.gone() &&
              live.hello.capabilities.includes("deliveries") &&
              (yield* Clock.currentTimeMillis) < until;
            if (!again) return yield* Effect.failCause(exit.cause);
            yield* Effect.logInfo("worker host: a delivery waits for its machine to dial in");
          }
        });
  const quiet = (run: (sessions: HostSessionsConnection) => Effect.Effect<void>) =>
    current.pipe(
      Effect.flatMap((connection) => run(connection.sessions)),
      Effect.exit,
      Effect.asVoid,
    );
  const disks = new Map<string, { opened?: string | undefined; seen?: string | undefined }>();
  const moves = new Map<string, number>();
  return {
    open: (request) =>
      awaitConnection(current, callMs).pipe(
        Effect.mapError((error) => new HostFailed({ message: error.message })),
        Effect.flatMap((live) => {
          const refused = timing.admit?.(request);
          if (refused !== undefined) return Effect.fail(new HostFailed({ message: refused }));
          return live.sessions.open(request).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                const disk = live.hello.diskId;
                disks.set(request.handle, { opened: disk, seen: disk });
              }),
            ),
          );
        }),
      ),
    replaced: (handle) => {
      const disk = disks.get(handle);
      return disk?.opened !== undefined && disk.seen !== undefined && disk.opened !== disk.seen;
    },
    moved: (handle) => moves.get(handle),
    events: (handle, afterSeq) => {
      let seen = afterSeq;
      let endHeldOnce = false;
      type Next = { readonly lost: false; readonly next: SequencedEvent } | { readonly lost: true };
      const follow = (
        connection: Effect.Effect<HostConnection, HostUnavailable>,
      ): ReturnType<HostSessionsConnection["events"]> =>
        Stream.unwrap(
          Effect.map(connection, (live) => {
            const disk = disks.get(handle);
            if (disk !== undefined) disk.seen = live.hello.diskId;
            return live.sessions.events(handle, seen).pipe(
              Stream.takeUntil((next) => next.event.type === "ended"),
              Stream.map((next): Next => ({ lost: false, next })),
              Stream.catchTag("HostUnavailable", () => Stream.make({ lost: true })),
              Stream.flatMap((item) => {
                if (item.lost) return lost();
                const { next } = item;
                if (next.event.type === "ended" && !endHeldOnce) return holdEnded(live, next);
                return Stream.sync(() => {
                  seen = next.seq;
                  return next;
                });
              }),
            );
          }),
        );
      const lost = () =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* Effect.logInfo("worker host: a session waits for its machine to dial in");
            return waitBack(yield* Clock.currentTimeMillis);
          }),
        );
      const holdEnded = (live: HostConnection, next: SequencedEvent) =>
        Stream.unwrap(
          Effect.gen(function* () {
            endHeldOnce = true;
            const within = timing.moving?.() === undefined ? ENDED_SETTLE_MS : MOVE_GONE_WITHIN_MS;
            const since = yield* Clock.currentTimeMillis;
            while (!live.gone() && (yield* Clock.currentTimeMillis) - since < within)
              yield* Effect.sleep(GONE_LOOK);
            if (!live.gone()) {
              seen = next.seq;
              return Stream.make(next);
            }
            yield* Effect.logInfo(
              "worker host: a session's agent ended as its machine went; it waits for the machine",
            );
            return waitBack(yield* Clock.currentTimeMillis);
          }),
        );
      const waitBack = (since: number): ReturnType<HostSessionsConnection["events"]> =>
        Stream.unwrap(
          wantedWhileMoving(
            Effect.gen(function* () {
              for (;;) {
                const back = yield* Effect.result(current);
                if (Result.isSuccess(back))
                  return Stream.unwrap(
                    Effect.logInfo("worker host: a session picked up after a redial").pipe(
                      Effect.as(follow(Effect.succeed(back.success))),
                    ),
                  );
                const moving = moves.get(handle) ?? timing.moving?.();
                if (moving !== undefined && !moves.has(handle)) {
                  moves.set(handle, moving);
                  yield* Effect.logInfo("worker host: a session waits for its machine to move");
                  return Stream.concat(
                    Stream.make<[SequencedEvent]>({
                      seq: seen,
                      event: { type: "machineMoving", until: since + moving },
                    }),
                    waitBack(since),
                  );
                }
                const now = yield* Clock.currentTimeMillis;
                if (now - since >= (moving ?? reattachOf())) return Stream.fail(back.failure);
                yield* Effect.sleep(LOOK_EVERY);
              }
            }),
          ),
        );
      const wantedWhileMoving = <A, E>(wait: Effect.Effect<A, E>) =>
        moves.has(handle) && timing.wanting !== undefined ? timing.wanting(wait) : wait;
      return follow(awaitConnection(current, callMs));
    },
    ack: (handle, seq) => quiet((s) => s.ack(handle, seq)),
    connectorsSeen: (handle) => {
      const follow = (wait: number): Stream.Stream<ConnectorsSeen> =>
        Stream.unwrap(
          awaitConnection(current, wait).pipe(
            Effect.map((live) =>
              Stream.concat(
                live.sessions.connectorsSeen(handle),
                Stream.unwrap(
                  Effect.sync(() => (live.gone() ? follow(reattachOf()) : Stream.empty)),
                ),
              ),
            ),
            Effect.orElseSucceed(() => Stream.empty),
          ),
        );
      return follow(callMs);
    },
    send: (handle, input, options) =>
      deliver(options?.deliveryId, (s) => s.send(handle, input, options)),
    steer: (handle, input, options) =>
      deliver(options?.deliveryId, (s) => s.steer(handle, input, options)),
    interrupt: (handle) => call((s) => s.interrupt(handle)),
    closeToolGate: (handle) => call((s) => s.closeToolGate(handle)),
    stopBackgroundTasks: (handle) => call((s) => s.stopBackgroundTasks(handle)),
    stopTask: (handle, taskId) => call((s) => s.stopTask(handle, taskId)),
    respond: (handle, requestId, answer) => call((s) => s.respond(handle, requestId, answer)),
    setMode: (handle, mode) => call((s) => s.setMode(handle, mode)),
    setModel: (handle, model) => call((s) => s.setModel(handle, model)),
    addDirectories: (handle, paths) => call((s) => s.addDirectories(handle, paths)),
    processId: (handle) => call((s) => s.processId(handle)),
    connectors: {
      status: (handle) => call((s) => s.connectors.status(handle)),
      reconnect: (handle, name) => call((s) => s.connectors.reconnect(handle, name)),
      setEnabled: (handle, name, enabled) =>
        call((s) => s.connectors.setEnabled(handle, name, enabled)),
      authenticate: (handle, name) => call((s) => s.connectors.authenticate(handle, name)),
    },
    close: (handle) =>
      quiet((s) => s.close(handle)).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            disks.delete(handle);
            moves.delete(handle);
          }),
        ),
      ),
    accountScope: (agent) => call((s) => s.accountScope?.(agent) ?? Effect.succeed(undefined)),
    reload: (agent, reload) => quiet((s) => s.reload(agent, reload)),
  };
};
