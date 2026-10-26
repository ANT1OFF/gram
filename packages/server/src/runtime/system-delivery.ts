// Server-authored input a thread takes once it is free (`ThreadRuntimesShape.requestSystemDelivery`).

import type { TurnId, ThreadStatus, UserInput } from "@gram/contracts";
import type * as Effect from "effect/Effect";

/**
 * Why a system delivery didn't reach the agent. `ended` and `error` are the thread's status, when
 * it was asked or when it got there with the delivery still waiting; `buildFailed` is `build`
 * dying; `sendFailed` is `AgentSession.send` dying; `turnError` is the adapter ending the turn in
 * `error` before it streamed anything; `recovered` and `sessionExit` are the host ending the turn
 * itself (the interrupt watchdog, and the session closing or crashing) before the adapter showed it
 * had the input; `limited` is the turn stopping on a provider limit the thread now waits out
 * (`Thread.limitWait`), which neither the agent nor the delivery did anything wrong in.
 */
export type SystemDeliveryFailure =
  | "ended"
  | "error"
  | "buildFailed"
  | "sendFailed"
  | "turnError"
  | "recovered"
  | "sessionExit"
  | "limited";

/**
 * What else the thread has going at the moment a delivery can be sent, for one that must only go to
 * a thread wholly at rest (idle compaction).
 */
export interface DeliveryRest {
  /** `idle`, or `error` for a thread whose last turn failed, which takes a delivery too. */
  readonly status: ThreadStatus;
  /** Background tasks (shells, monitors) the agent still runs; one finishing opens a turn. */
  readonly background: number;
  /** A subagent of an earlier turn still runs. */
  readonly subagentsRunning: boolean;
  /** Other deliveries waiting behind this one. */
  readonly waiting: number;
}

/**
 * One server-authored input. Exactly one of `accepted` and `failed` is called, once, for a delivery
 * whose `build` returned an input; neither for one whose `build` returned `undefined`, or that a
 * later request with the same key replaced before it was sent. After either, the runtime has
 * forgotten the request: ask again to retry.
 */
export interface SystemDelivery {
  /**
   * Called at the moment the thread can take the input, with the id of the turn that will carry
   * it; `undefined` drops the request and opens no turn. Runs with the runtime lock held, so it
   * must not call a `ThreadRuntimes` method that takes this thread's lock; if it dies the delivery
   * fails with `buildFailed`.
   */
  build(turnId: TurnId, rest: DeliveryRest): Effect.Effect<UserInput | undefined>;
  /**
   * The adapter took it: the turn that carried it streamed a chunk of its reply, or the adapter
   * itself ended that turn as `completed`, `maxTurns` or `interrupted`.
   */
  accepted(turnId: TurnId): Effect.Effect<void>;
  /** It did not reach the agent; `turnId` is absent when no turn was opened for it. */
  failed(turnId: TurnId | undefined, reason: SystemDeliveryFailure): Effect.Effect<void>;
}
