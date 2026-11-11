// How Gram hands a thread a message of its own making by default: steered into a running turn,
// cancelling nothing, and otherwise sent as `send` would take it.

import type { ThreadId, UserInput } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { ThreadRuntimesShape } from "./thread-runtimes-shape.ts";

/** How `steerOrSend` delivered: into the running turn, behind it, or as a turn of its own. */
export type SteerOrSendResult = "steered" | "queued" | "sent";

/**
 * Steers `input` into the thread's turn while it is `running` on an agent that takes mid-turn
 * input. Anything else goes through `fallback` (by default `send`): a thread at rest starts a turn,
 * and a turn waiting on the user's approval or answer, one starting up, or one that ended before
 * the steer landed, gets it queued. A steer the agent refused recorded nothing, so the fallback
 * never delivers it twice.
 */
export const steerOrSend = <E = never>(
  runtimes: Pick<ThreadRuntimesShape, "summaryOf" | "steer" | "send">,
  threadId: ThreadId,
  input: UserInput,
  fallback?: Effect.Effect<{ readonly queued: boolean }, E>,
) =>
  Effect.gen(function* () {
    const summary = yield* runtimes.summaryOf(threadId);
    const steered =
      summary?.capabilities?.steer === true &&
      summary.status === "running" &&
      (yield* runtimes.steer(threadId, input).pipe(
        Effect.as(true),
        // The turn can end, or reach a card, between the snapshot and the steer.
        Effect.catchTag("InvalidState", () => Effect.succeed(false)),
      ));
    if (steered) return "steered" as SteerOrSendResult;
    const { queued } = yield* fallback ?? runtimes.send(threadId, input);
    return (queued ? "queued" : "sent") as SteerOrSendResult;
  });
