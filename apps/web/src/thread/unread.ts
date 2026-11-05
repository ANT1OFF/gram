import type { GramUIMessage, ThreadId } from "@gram/contracts";
import { useState } from "react";

// Where "New" goes in a transcript: over the first message that came after the user last looked at
// the thread (`Thread.lastViewedAt`, the moment "Since you looked" counts from too). Decided once,
// as the view opens: what arrives while you watch is something you saw.

/** The user's own words, which they saw as they sent them. */
const ownWords = (message: GramUIMessage) =>
  message.role === "user" && !message.parts.some((part) => part.type === "data-thread-origin");

/**
 * The id of the first message after `since` that the user didn't write, when something before it
 * was seen: with nothing seen yet, or nothing new, there is no line to draw.
 */
export function firstUnseen(
  messages: readonly GramUIMessage[],
  since: number | undefined,
): string | undefined {
  if (since === undefined) return undefined;
  const index = messages.findIndex(
    (message) => (message.metadata?.createdAt ?? 0) > since && !ownWords(message),
  );
  return index > 0 ? messages[index]!.id : undefined;
}

/**
 * `firstUnseen` for `threadId`, taken the first render its messages are in, and again only for
 * another thread.
 */
export function useUnseenFrom(
  threadId: ThreadId,
  messages: readonly GramUIMessage[],
  since: number | undefined,
  loaded: boolean,
): string | undefined {
  const [decided, setDecided] = useState<{ threadId: ThreadId; id: string | undefined }>();
  if (loaded && decided?.threadId !== threadId) {
    setDecided({ threadId, id: firstUnseen(messages, since) });
  }
  return decided?.threadId === threadId ? decided.id : undefined;
}
