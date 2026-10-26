// A user's input as the runtime keeps it, and the transcript message a turn opens with.

import type { TurnId, UserInput, QueuedInput, GramUIMessage } from "@gram/contracts";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

/** A client's input with no `waitNote`, which only the server sets. */
export const typedInput = (input: UserInput): UserInput => {
  const { waitNote, ...typed } = input;
  return waitNote === undefined ? input : typed;
};

/** A queued item put back after a send that didn't go: its turn was closed, and isn't reused. */
export const notInFlight = (item: QueuedInput): QueuedInput => {
  const { turnId: _, ...queued } = item;
  return queued;
};

/**
 * `input` given to `send` or `steer`, its `author` as the server establishes it: Gram's when it
 * carries a notice or its caller said so, the user's unless another thread sent it (`origin`).
 */
export const authored = (input: UserInput): UserInput => {
  const { author, ...rest } = input;
  if (author === "server" || input.notice !== undefined) return { ...rest, author: "server" };
  return input.origin === undefined ? { ...rest, author: "user" } : rest;
};

/**
 * What the user typed of `input`, without the note on Waiting on you the server added to it, even
 * where an edit of the queued message left it other than at the end.
 */
export const typedText = (input: UserInput) => {
  const note = input.waitNote;
  if (note === undefined) return input.text;
  const at = input.text.lastIndexOf(note);
  if (at === -1) return input.text;
  const before = input.text.slice(0, at);
  return (
    (before.endsWith("\n\n") ? before.slice(0, -2) : before) + input.text.slice(at + note.length)
  );
};

/**
 * A user message's parts: its text, attached files, the notice or origin the transcript shows, and
 * what Gram told the agent with it.
 */
export const userParts = (input: UserInput, messageId: string) => [
  { type: "text", text: typedText(input) },
  // What was attached, so the transcript shows it; the agent gets the paths as mentions.
  ...(input.attachments ?? []).map((attachment) => ({
    type: "file",
    mediaType: attachment.mediaType ?? "application/octet-stream",
    filename: attachment.name ?? basename(attachment.path),
    url: pathToFileURL(attachment.path).href,
  })),
  ...(input.notice === undefined
    ? []
    : [
        input.notice.kind === "orchestration"
          ? { type: "data-orchestration-digest", id: messageId, data: input.notice }
          : input.notice.kind === "idleCompact"
            ? { type: "data-idle-compact", id: messageId, data: input.notice }
            : input.notice.kind === "humanReview"
              ? { type: "data-human-review-notice", id: messageId, data: input.notice }
              : { type: "data-review-notice", id: messageId, data: input.notice },
      ]),
  ...(input.origin === undefined
    ? []
    : [{ type: "data-thread-origin", id: messageId, data: input.origin }]),
  ...(input.waitNote === undefined
    ? []
    : [{ type: "data-wait-note", id: messageId, data: { text: input.waitNote } }]),
];

/** The user message a turn opens with. */
export const userMessage = (
  input: UserInput,
  messageId: string,
  turnId: TurnId,
  createdAt: number,
) =>
  ({
    id: messageId,
    role: "user",
    parts: userParts(input, messageId),
    metadata: {
      turnId,
      createdAt,
      agentMessageIds: [messageId],
      ...(input.author === undefined ? {} : { author: input.author }),
    },
  }) as unknown as GramUIMessage;
