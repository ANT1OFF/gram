import { HostFailed, type HostUnavailable } from "@gram/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { HostConnection, HostSessionsConnection } from "./protocol.ts";

/**
 * How long a session on a joined machine waits for the machine to dial in again after its
 * connection dropped, before it counts as ended with it. Less than the host's own
 * `DETACHED_GRACE_MS`, so the host still has it when this side gives up.
 */
export const REATTACH_WITHIN_MS = 2 * 60_000;
/** How long a call into a session (a send, an answer) waits for the machine to be back. */
export const CALL_WAIT_MS = 15_000;
/** How often a dropped machine is looked for again. */
const LOOK_EVERY = "500 millis";

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
  /** The machine's connection now, failing while it is offline. */
  current: Effect.Effect<HostConnection, HostUnavailable>,
  timing: { readonly reattachMs?: number; readonly callMs?: number } = {},
): HostSessionsConnection => {
  const reattachMs = timing.reattachMs ?? REATTACH_WITHIN_MS;
  const callMs = timing.callMs ?? CALL_WAIT_MS;
  const sessions = awaitConnection(current, callMs).pipe(
    Effect.map((connection) => connection.sessions),
  );
  /** A call that keeps its own errors, an offline machine reading as `HostFailed`. */
  const call = <A, E>(
    run: (sessions: HostSessionsConnection) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | HostFailed> =>
    sessions.pipe(
      Effect.mapError((error) => new HostFailed({ message: error.message })),
      Effect.flatMap(run),
    );
  /**
   * A call with nothing to report, which a machine that is away leaves undone. Its exit is
   * dropped whole: a connection torn down under it interrupts the call, and a close run as a
   * finalizer must not fail the scope it closes.
   */
  const quiet = (run: (sessions: HostSessionsConnection) => Effect.Effect<void>) =>
    sessions.pipe(Effect.flatMap(run), Effect.exit, Effect.asVoid);
  return {
    open: (request) => call((s) => s.open(request)),
    events: (handle, afterSeq) => {
      let seen = afterSeq;
      const follow = (
        connection: Effect.Effect<HostConnection, HostUnavailable>,
      ): ReturnType<HostSessionsConnection["events"]> =>
        Stream.unwrap(
          Effect.map(connection, (live) =>
            live.sessions.events(handle, seen).pipe(
              Stream.tap((next) =>
                Effect.sync(() => {
                  seen = next.seq;
                }),
              ),
              Stream.catchTag("HostUnavailable", () =>
                Stream.unwrap(
                  Effect.logInfo("worker host: a session waits for its machine to dial in").pipe(
                    Effect.as(
                      follow(
                        awaitConnection(current, reattachMs).pipe(
                          Effect.tap(() =>
                            Effect.logInfo("worker host: a session picked up after a redial"),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      return follow(awaitConnection(current, callMs));
    },
    ack: (handle, seq) => quiet((s) => s.ack(handle, seq)),
    connectorsSeen: (handle) =>
      Stream.unwrap(
        sessions.pipe(
          Effect.map((s) => s.connectorsSeen(handle)),
          Effect.orElseSucceed(() => Stream.empty),
        ),
      ),
    send: (handle, input, options) => call((s) => s.send(handle, input, options)),
    steer: (handle, input) => call((s) => s.steer(handle, input)),
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
    close: (handle) => quiet((s) => s.close(handle)),
    reload: (agent, reload) => quiet((s) => s.reload(agent, reload)),
  };
};
