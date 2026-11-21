import { asGhCaller } from "@gram/git";
import type { ThreadId } from "@gram/contracts";
import type * as Effect from "effect/Effect";
import { ghThreadEnv } from "./github-relay.ts";

/** The caller environment of `threadId`'s reads: its handle behind a relay, else none. */
export const threadCaller = (threadId: ThreadId | string): Readonly<Record<string, string>> =>
  ghThreadEnv(threadId);

/** Runs `effect` with every `gh` read in it made for `threadId`. */
export const forThread = (threadId: ThreadId | string) => asGhCaller(threadCaller(threadId));

/** `forThread(threadId)`, or `effect` as it is when there is no thread. */
export const forThreadIf =
  (threadId: ThreadId | string | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    threadId === undefined ? effect : forThread(threadId)(effect);
