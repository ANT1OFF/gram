import type { AskedBy, GramUIMessage } from "@gram/contracts";

/** How far back past its workers' messages an orchestrator's latest ask is looked for. */
const LOOK_BACK = 5;

/**
 * The thread outside the workspace an orchestrator was answering, from its messages oldest first:
 * the latest one, its workers' messages after it aside, when another thread sent it. Undefined when
 * the user's own words, or Gram's, came after it, so a worker is never put down to an old ask.
 */
export const askedByOf = (messages: ReadonlyArray<GramUIMessage>): AskedBy | undefined => {
  for (const message of messages.slice(-LOOK_BACK).toReversed()) {
    const origin = message.parts.find((part) => part.type === "data-thread-origin")?.data;
    if (origin === undefined) return undefined;
    // A worker's message carries its feature: the orchestrator's own work, not an ask from outside.
    if (origin.feature !== undefined) continue;
    return { threadId: origin.threadId, title: origin.title };
  }
  return undefined;
};
