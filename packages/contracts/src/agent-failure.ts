// A leaf beside `ids.ts`: `agent.ts` puts a failure on the turn end, `domain.ts` keeps the last one
// on the thread, and `orchestration.ts` carries it into the ledger, so nothing here may import them.
import * as Schema from "effect/Schema";
import { TurnId } from "./ids.ts";

/**
 * What kind of failure ended a turn, as far as the agent's own error report tells. `gatewayRefused`
 * is a gateway answering that it won't route this request at all (LiteLLM's "No deployments
 * available"), which looks like a rate limit on the wire but never clears by waiting; `costGuard`
 * is a gateway key disabled or restricted by its spending limit.
 */
export const AgentFailureKind = Schema.Literals([
  "rateLimit",
  "auth",
  "modelUnavailable",
  "gatewayRefused",
  "costGuard",
  "network",
  "unknown",
]);
export type AgentFailureKind = typeof AgentFailureKind.Type;

/** The classified part of an agent's error: no text of the agent's or the API's. */
export const AgentFailure = Schema.Struct({
  kind: AgentFailureKind,
  /** The upstream HTTP status, when the agent reported one. */
  httpStatus: Schema.optionalKey(Schema.Int),
  /** The agent's own name for the error, e.g. Codex's `responseTooManyFailedAttempts`. */
  code: Schema.optionalKey(Schema.String),
  /** Sending the same message again may work; false for a refusal that would only repeat. */
  retryable: Schema.Boolean,
});
export type AgentFailure = typeof AgentFailure.Type;

/**
 * A thread waiting out a provider limit instead of failing (`Thread.limitWait`): `limit` is a
 * subscription limit with a reset time, `backoff` a 429 that said none, retried with a growing delay.
 * Gram resumes the interrupted turn at `resumeAt` unless the user resumes or cancels it first.
 * Opaque, so `Thread`'s declared type names it rather than spelling it out.
 */
export class LimitWait extends Schema.Opaque<LimitWait>()(
  Schema.Struct({
    kind: Schema.Literals(["limit", "backoff"]),
    /** The login the limit belongs to: `agent/profileId`, shared by every thread on it. */
    account: Schema.String,
    /**
     * Epoch ms the provider said the limit resets. A `backoff` keeps the reset already waited out,
     * if any, which a later reading must pass to count as new.
     */
    resetsAt: Schema.optionalKey(Schema.Number),
    /** Epoch ms Gram resumes the thread: the reset, staggered across the account's threads. */
    resumeAt: Schema.Number,
    /** Epoch ms the thread first stopped on this limit. */
    since: Schema.Number,
    /** Retries made so far on a `backoff` wait; 0 for `limit`. */
    attempt: Schema.Int,
    /** The turn the limit interrupted. */
    turnId: Schema.optionalKey(TurnId),
    /**
     * The user cancelled the wait: nothing resumes it on its own, and what waits behind it stays
     * held, until the user sends or resumes it.
     */
    cancelled: Schema.optionalKey(Schema.Literal(true)),
    /**
     * Epoch ms fresh data showed the limit no longer applies (readings below it, or a turn on the
     * account that went through): the wait ends early, at `resumeAt`, rather than at its reset.
     */
    cleared: Schema.optionalKey(Schema.Number),
  }),
) {}

/**
 * A limit wait that ended early because fresh data showed the limit no longer applied
 * (`Thread.limitCleared`): when it resumed, and the reset it no longer waited for.
 */
export class LimitCleared extends Schema.Opaque<LimitCleared>()(
  Schema.Struct({
    /** Epoch ms the thread resumed. */
    at: Schema.Number,
    /** Epoch ms the wait was to end at, had the limit held. */
    resetsAt: Schema.optionalKey(Schema.Number),
  }),
) {}

/** The longest `ThreadError.text` may be. */
export const THREAD_ERROR_TEXT_MAX = 300;

/**
 * The error a thread's last failed turn ended with, kept until a later turn completes. `text` is
 * Gram's own sentence for the failure, with at most a redacted, clipped excerpt of the
 * agent's message, fit to show anywhere the thread is.
 */
export const ThreadError = Schema.Struct({
  ...AgentFailure.fields,
  text: Schema.String.check(Schema.isMaxLength(THREAD_ERROR_TEXT_MAX)),
  /** Absent when the agent failed before any turn, e.g. it couldn't start. */
  turnId: Schema.optionalKey(TurnId),
  /** Epoch ms. */
  at: Schema.Number,
});
export type ThreadError = typeof ThreadError.Type;
