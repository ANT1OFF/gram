/**
 * The user's own messages, attached word for word to what an orchestrator sends a worker
 * (`userMessages` on `spawn_worker` and `send_message`). A brief is the orchestrator's prompt, which
 * is usually better than the user's for a worker; what it shouldn't do is retype a long paste (a
 * log, a spec, an error) the worker needs exactly. Gram copies those from the orchestrator's own
 * transcript instead, after the text, under a line saying whose they are.
 *
 * Only an orchestrator's transcript is read, and in it only messages the server recorded as the
 * user's own (`author: "user"`, set where the user types into Gram). A user-role message is not
 * enough: Gram's notices, digests and other threads' messages are user-role too, and a row from
 * before Gram recorded authors is never taken as the user's.
 */
import { AppToolError, type GramUIMessage, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { fileURLToPath } from "node:url";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";

/** How many of the user's latest messages one call may attach. */
export const USER_MESSAGES_MAX = 5;
/** Characters of the user's words one call may attach, all messages together. */
export const USER_WORDS_MAX = 100_000;

/** One message of the user's, as attached. */
export interface UserWords {
  readonly text: string;
  /** Paths of the files attached to it, which aren't copied. */
  readonly files: ReadonlyArray<string>;
}

/** The parts a message the user typed may carry besides its text and files. */
const TYPED_DATA_PARTS: ReadonlySet<string> = new Set(["data-wait-note"]);

/** The user's own messages in an orchestrator's transcript, oldest first. */
export const userMessagesOf = (messages: ReadonlyArray<GramUIMessage>): ReadonlyArray<UserWords> =>
  messages.flatMap((message) => {
    if (message.role !== "user" || message.metadata?.author !== "user") return [];
    const parts = message.parts as ReadonlyArray<{
      readonly type: string;
      readonly text?: string;
      readonly url?: string;
      readonly filename?: string;
    }>;
    if (parts.some((part) => part.type.startsWith("data-") && !TYPED_DATA_PARTS.has(part.type))) {
      return [];
    }
    const text = parts
      .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
      .join("\n");
    const files = parts.flatMap((part) => {
      if (part.type !== "file" || part.url === undefined) return [];
      try {
        return [fileURLToPath(part.url)];
      } catch {
        return part.filename === undefined ? [] : [part.filename];
      }
    });
    return text.trim() === "" && files.length === 0 ? [] : [{ text, files }];
  });

/** `text`, then `words` under a line saying they are the user's, copied by Gram. */
export const withUserWords = (text: string, words: ReadonlyArray<UserWords>): string => {
  if (words.length === 0) return text;
  const latest =
    words.length === 1 ? "their latest message" : `their latest ${words.length}, oldest first`;
  const blocks = words.map((each, index) => {
    const head = words.length === 1 ? [] : [`[${index + 1} of ${words.length}]`];
    const files =
      each.files.length === 0
        ? []
        : [`(Files attached to it, not copied: ${each.files.join(", ")})`];
    return [...head, each.text, ...files].join("\n");
  });
  return [
    text,
    "",
    "---",
    `The user's own words to the orchestrator, ${latest}, copied word for word by Gram. Everything below this line is the user's:`,
    "",
    blocks.join("\n\n"),
  ].join("\n");
};

/** The line a workspace's worker brief footer starts under, which says whose it is. */
export const BRIEF_FOOTER_LINE =
  "This workspace's standing instructions, which the user set in its settings and Gram adds to every worker brief:";

/**
 * `brief` with the workspace's worker brief footer after it, under a line saying it is the user's
 * standing instructions for the workspace; `brief` itself without one. The user's own words,
 * when attached, come after this, so everything under their line stays theirs.
 */
export const withBriefFooter = (brief: string, footer: string | undefined): string =>
  footer === undefined ? brief : [brief, "", "---", BRIEF_FOOTER_LINE, "", footer].join("\n");

/**
 * `text` with the latest `count` of the user's messages in `caller`'s transcript after it, for
 * `tool`. Refused for a caller that isn't an orchestrator, when it has none, and when they are
 * longer together than `USER_WORDS_MAX`.
 */
export const attachUserWords = (
  store: Pick<ThreadStoreShape, "getThread" | "listMessages">,
  tool: string,
  caller: ThreadId,
  text: string,
  count: number | undefined,
): Effect.Effect<string, AppToolError> =>
  Effect.gen(function* () {
    if (count === undefined || count === 0) return text;
    const thread = yield* store
      .getThread(caller)
      .pipe(Effect.mapError(() => new AppToolError({ tool, message: "Your thread is gone." })));
    if (thread.role !== "orchestrator") {
      return yield* new AppToolError({
        tool,
        message:
          "`userMessages` attaches the user's messages from an orchestrator's conversation; this thread isn't one. Quote what the recipient needs in `text`.",
      });
    }
    const words = userMessagesOf(yield* store.listMessages(caller)).slice(-count);
    if (words.length === 0) {
      return yield* new AppToolError({
        tool,
        message:
          "There is no message from the user in your conversation to attach. Leave out `userMessages`.",
      });
    }
    const length = words.reduce((sum, each) => sum + each.text.length, 0);
    if (length > USER_WORDS_MAX) {
      return yield* new AppToolError({
        tool,
        message: `The user's latest ${words.length === 1 ? "message is" : `${words.length} messages are`} ${length} characters, more than the ${USER_WORDS_MAX} one call attaches. Attach fewer, or tell the worker what it needs from them.`,
      });
    }
    return withUserWords(text, words);
  });
