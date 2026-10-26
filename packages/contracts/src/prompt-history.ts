import * as Schema from "effect/Schema";
import { ThreadId } from "./ids.ts";
import type { GramUIMessage } from "./ui-message.ts";

/** Prompts ↑ can walk back through. */
export const PROMPT_HISTORY_LIMIT = 50;

/** Other threads of the project whose prompts count, most recently active first. */
export const PROMPT_HISTORY_THREADS = 20;

export const PromptHistoryFields = {
  threadId: ThreadId,
  /** At most `PROMPT_HISTORY_LIMIT`. */
  limit: Schema.optionalKey(Schema.Int),
};

export const PromptHistory = Schema.Struct({
  /** Newest first, duplicates collapsed. */
  prompts: Schema.Array(Schema.String),
});
export type PromptHistory = typeof PromptHistory.Type;

/** The text a user message typed; attachments and data parts don't count. */
const typedText = (message: GramUIMessage): string =>
  message.role !== "user"
    ? ""
    : message.parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
        .trim();

/**
 * The prompts ↑ recalls, derived from stored transcripts: each transcript's user messages newest
 * first, transcripts in the order given (the current thread first), duplicates collapsed, at most
 * `limit`. Only sent messages are stored, so drafts never appear.
 */
export function promptsFromMessages(
  transcripts: ReadonlyArray<ReadonlyArray<GramUIMessage>>,
  limit = PROMPT_HISTORY_LIMIT,
): string[] {
  const seen = new Set<string>();
  const prompts: string[] = [];
  for (const messages of transcripts) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const text = typedText(messages[i]!);
      if (text === "" || seen.has(text)) continue;
      seen.add(text);
      prompts.push(text);
      if (prompts.length >= limit) return prompts;
    }
  }
  return prompts;
}
