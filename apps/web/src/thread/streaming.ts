import type { ThreadStatus } from "@gram/contracts";

const TURN_IN_PROGRESS: ReadonlySet<ThreadStatus> = new Set([
  "starting",
  "running",
  "needsApproval",
  "needsInput",
]);

const NONE: ReadonlySet<string> = new Set();

/**
 * The messages to treat as streaming. Once the turn is over nothing streams, even if a message's
 * stream was never closed (a real adapter can end a turn without that message's `finish` reaching
 * the feed), so its actions don't stay hidden until a reload. Subagent transcripts in `nested` are
 * the exception: a subagent running in the background streams on after the turn that launched it.
 */
export function activeStreamingIds(
  status: ThreadStatus | undefined,
  streamingIds: readonly string[],
  nested: ReadonlySet<string> = NONE,
): ReadonlySet<string> {
  if (streamingIds.length === 0) return NONE;
  if (status !== undefined && TURN_IN_PROGRESS.has(status)) return new Set(streamingIds);
  const background = streamingIds.filter((id) => nested.has(id));
  return background.length === 0 ? NONE : new Set(background);
}
