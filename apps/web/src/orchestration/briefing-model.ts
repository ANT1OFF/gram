import type { FeatureCard, GramUIMessage, ThreadStatus } from "@gram/contracts";

import { inTurn } from "@/thread/orchestration-model";
import { isToolPart, toolNameOf } from "@/thread/parts";

// The path from a message to the orchestrator to a feature card, made visible: a "briefing"
// placeholder from the moment it is sent until the card it led to arrives. The orchestrator still
// decides whether to brief anyone; when it only answers, the placeholder goes. Pure, so it is
// tested without a thread.

/** `reading` until the orchestrator calls `spawn_worker`, then `briefing` until the card is in. */
type BriefingPhase = "reading" | "briefing";

export interface Briefing {
  /** The message it follows: where it sits in the stream. */
  readonly messageId: string;
  /** A few of its words, for the placeholder's title. */
  readonly excerpt: string;
  readonly phase: BriefingPhase;
}

/** How long a message nobody answered keeps its placeholder, in ms. */
export const BRIEFING_STALE_MS = 2 * 60_000;

/** The most words the placeholder's title takes from the message. */
const EXCERPT_WORDS = 4;

/** Data parts that mark a user-role message as sent by Gram or another thread, not typed. */
const NOT_TYPED = new Set([
  "data-thread-origin",
  "data-orchestration-digest",
  "data-review-notice",
  "data-human-review-notice",
  "data-babysit-report",
]);

const typedByUser = (message: GramUIMessage): boolean =>
  message.role === "user" && !message.parts.some((part) => NOT_TYPED.has(part.type));

const textOf = (message: GramUIMessage): string =>
  message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .trim();

/** The first few words, an ellipsis saying some were left out. */
export const excerptOf = (text: string, max = EXCERPT_WORDS): string => {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length <= max ? words.join(" ") : `${words.slice(0, max).join(" ")}…`;
};

/** When the orchestrator called `spawn_worker` in `messages`, if it did and the call didn't fail. */
const spawnedAt = (messages: readonly GramUIMessage[]): number | undefined => {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const spawned = message.parts.some(
      (part) =>
        isToolPart(part) &&
        toolNameOf(part).endsWith("spawn_worker") &&
        part.state !== "output-error" &&
        part.state !== "output-denied",
    );
    if (spawned) return message.metadata?.createdAt ?? 0;
  }
  return undefined;
};

/**
 * The placeholder an orchestrator's stream shows under the user's latest message, or `undefined`.
 * It is replaced once a card is made after the message, or, for a worker added to a feature that
 * has a card, once that card changes after the spawn. A turn that ends without a spawn takes it
 * away, as does a message nothing answered for `BRIEFING_STALE_MS`.
 */
export function briefingOf(input: {
  readonly messages: readonly GramUIMessage[];
  readonly cards: readonly FeatureCard[];
  readonly status: ThreadStatus | undefined;
  readonly now: number;
}): Briefing | undefined {
  const { messages, cards, status, now } = input;
  const index = messages.findLastIndex(typedByUser);
  const sent = messages[index];
  const since = sent?.metadata?.createdAt;
  if (sent === undefined || since === undefined) return undefined;
  const after = messages.slice(index + 1);
  const spawn = spawnedAt(after);
  const replaced = cards.some(
    (card) => card.createdAt >= since || (spawn !== undefined && card.updatedAt >= spawn),
  );
  if (replaced) return undefined;
  // A digest or another thread's message after it starts a turn of its own: its turn is over.
  const turnGoesOn = inTurn(status) && !after.some((message) => message.role === "user");
  const answered = after.some((message) => message.role === "assistant");
  if (spawn === undefined) {
    // The turn ended without briefing anyone: the orchestrator only answered.
    if (!turnGoesOn && answered) return undefined;
    if (!turnGoesOn && now - since > BRIEFING_STALE_MS) return undefined;
  } else if (!turnGoesOn && now - spawn > BRIEFING_STALE_MS) {
    // A spawn whose card never came, such as one refused after the call.
    return undefined;
  }
  return {
    messageId: sent.id,
    excerpt: excerptOf(textOf(sent)),
    phase: spawn === undefined ? "reading" : "briefing",
  };
}
