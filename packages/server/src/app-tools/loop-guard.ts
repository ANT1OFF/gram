// The loop guard for agent-driven messages between threads: no self-sends, no
// back-to-back sends into a thread nobody else has written to, a hop limit and a rate limit.

import type { MessageOrigin, ThreadId } from "@gram/contracts";

/** Messages one thread may send to other threads per minute. */
export const SENDS_PER_MINUTE = 5;
/** Thread-to-thread hops a message may travel: A → B → C, but C can't send on. */
export const MAX_CHAIN_DEPTH = 2;
/** The window `SENDS_PER_MINUTE` is counted over; the orchestrator's guard counts over the same one. */
export const WINDOW_MS = 60_000;

export interface SendCheck {
  readonly caller: ThreadId;
  readonly target: ThreadId;
  /** The origin of the caller's latest user message, when another thread sent it. */
  readonly callerOrigin: MessageOrigin | undefined;
  /** The target's user inputs, oldest first: sent messages, then queued ones. */
  readonly targetInputs: ReadonlyArray<{ readonly origin?: MessageOrigin | undefined }>;
  /** Epoch ms of the caller's earlier sends. */
  readonly recentSends: ReadonlyArray<number>;
  readonly now: number;
}

export type SendVerdict =
  | {
      readonly ok: true;
      /** The origin depth the sent message carries. */
      readonly depth: number;
      /** The caller's sends inside the window, this one included. */
      readonly recentSends: ReadonlyArray<number>;
    }
  | { readonly ok: false; readonly reason: string };

export const checkSend = (check: SendCheck): SendVerdict => {
  if (check.caller === check.target) {
    return { ok: false, reason: "A thread can't send a message to itself." };
  }
  const depth = (check.callerOrigin?.depth ?? 0) + 1;
  if (check.callerOrigin !== undefined && depth > MAX_CHAIN_DEPTH) {
    return {
      ok: false,
      reason: `This thread is working on a message another thread sent (“${check.callerOrigin.title}”), and messages stop after ${MAX_CHAIN_DEPTH} hops between threads. Ask the user instead.`,
    };
  }
  if (check.targetInputs.at(-1)?.origin?.threadId === check.caller) {
    return {
      ok: false,
      reason:
        "The last message into that thread already came from this thread, and nobody has written to it since. Wait for the user to write there, or ask the user.",
    };
  }
  const recent = check.recentSends.filter((at) => check.now - at < WINDOW_MS);
  if (recent.length >= SENDS_PER_MINUTE) {
    const oldest = recent[0] ?? check.now;
    const wait = Math.max(1, Math.ceil((WINDOW_MS - (check.now - oldest)) / 1000));
    return {
      ok: false,
      reason: `send_message allows ${SENDS_PER_MINUTE} messages a minute per thread; try again in ${wait}s.`,
    };
  }
  return { ok: true, depth, recentSends: [...recent, check.now] };
};
