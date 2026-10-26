import * as Schema from "effect/Schema";
import { ThreadId } from "./ids.ts";

/**
 * `git.refresh`: re-reads the thread's git state and PR badge now, network tier included, instead of
 * waiting for the next sweep. The result arrives as a `git.state` event; panels refetch their own
 * queries alongside it.
 */
export const GitRefreshPayload = Schema.Struct({ threadId: ThreadId });
export type GitRefreshPayload = typeof GitRefreshPayload.Type;
