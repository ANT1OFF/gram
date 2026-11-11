// Server-authored input a thread takes once it is free (`ThreadRuntimesShape.requestSystemDelivery`).

import type { TurnId, ThreadStatus, UserInput } from "@gram/contracts";
import type * as Effect from "effect/Effect";

/**
 * The key of the handoff a thread's switch gives its new session. While a plain thread's or
 * worker's switch is `ready`, it is the one delivery that may go: nothing reaches the new session
 * before it.
 */
export const SWITCH_HANDOFF_KEY = "switch-handoff";

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
  /**
   * `idle`, or `error` for a thread whose last turn failed, which takes a delivery too; `running`
   * for one steered into a turn.
   */
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
 * later request with the same key replaced before it was sent (or, steered into a turn that erred,
 * before it was sent again). After either, the runtime has forgotten the request: ask again to
 * retry.
 */
export interface SystemDelivery {
  /**
   * Steered into a `running` turn that can take it, cancelling nothing, and accepted once the
   * agent takes it, rather than waiting for the turn's end. Absent, it is always a turn of its own,
   * as one that must find the thread at rest (idle compaction) or end a turn of its own (a
   * handoff's checkpoint) needs.
   */
  readonly steer?: boolean;
  /**
   * Called at the moment the thread can take the input, with the id of the turn that will carry
   * it; `undefined` drops the request and opens no turn. Runs with the runtime lock held, so it
   * must not call a `ThreadRuntimes` method that takes this thread's lock; if it dies the delivery
   * fails with `buildFailed`.
   */
  build(turnId: TurnId, rest: DeliveryRest): Effect.Effect<UserInput | undefined>;
  /**
   * The adapter took it: the turn that carried it streamed a chunk of its reply, or the adapter
   * itself ended that turn as `completed`, `maxTurns` or `interrupted`; for a steered one, the
   * agent took the steer.
   */
  accepted(turnId: TurnId): Effect.Effect<void>;
  /**
   * The agent natively began the turn that carries it, before or without accepting it as above:
   * its own turn start, or the first event of the turn (`DeliveryStart` lists what counts), which
   * a refusal (Codex's rejected `turn/start`) never sends. Called at most once, ahead of `accepted`
   * or `failed`, which are still called as they would be. Optional: most deliveries need only those.
   */
  started?(turnId: TurnId): Effect.Effect<void>;
  /** It did not reach the agent; `turnId` is absent when no turn was opened for it. */
  failed(turnId: TurnId | undefined, reason: SystemDeliveryFailure): Effect.Effect<void>;
}
