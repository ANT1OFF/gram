import { InvalidState, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { ThreadPortsShape } from "../ports/service.ts";
import type { TerminalGateShape } from "../terminal/gate.ts";
import type { CloseThreadOptions, ThreadRuntimesShape } from "./thread-runtimes.ts";

/**
 * `ThreadRuntimes.close` with `onlyAtRest`, first refusing, stopping nothing, while one of the
 * thread's terminals runs a command, by a scan of its own: the periodic one can be five seconds
 * old. A scan that fails, or no `ThreadPorts` at all, refuses too, since then nothing is ruled out.
 * The thread's terminals take no new shell or input from before the scan until the close is done
 * or refused (`gate`), so nothing typed after the scan runs in a checkout about to go. Terminals are
 * `ThreadPorts`' and the terminal handlers', which sit above the runtimes, so this can't live in
 * `close`.
 */
export const closeAtRest = (
  runtimes: Pick<ThreadRuntimesShape, "close" | "releaseAfterClose">,
  ports: Pick<ThreadPortsShape, "busyTerminalsNow"> | undefined,
  gate: Pick<TerminalGateShape, "hold"> | undefined,
  threadId: ThreadId,
  options: Omit<CloseThreadOptions, "onlyAtRest"> = {},
) =>
  Effect.acquireUseRelease(
    gate === undefined ? Effect.succeed(Effect.void) : gate.hold(threadId),
    () => scanThenClose(runtimes, ports, threadId, options),
    // Not before the close is over, though its caller's wait for it can end sooner.
    (release) => runtimes.releaseAfterClose(threadId, release),
  );

const scanThenClose = (
  runtimes: Pick<ThreadRuntimesShape, "close">,
  ports: Pick<ThreadPortsShape, "busyTerminalsNow"> | undefined,
  threadId: ThreadId,
  options: Omit<CloseThreadOptions, "onlyAtRest">,
) =>
  Effect.gen(function* () {
    const busy = ports === undefined ? undefined : yield* ports.busyTerminalsNow;
    if (busy === undefined || busy.includes(threadId)) {
      return yield* new InvalidState({
        message:
          busy === undefined
            ? "the thread's terminals couldn't be read, so it was left open"
            : "a terminal of the thread is running a command, so it was left open",
        threadId,
      });
    }
    return yield* runtimes.close(threadId, { ...options, onlyAtRest: true });
  });
