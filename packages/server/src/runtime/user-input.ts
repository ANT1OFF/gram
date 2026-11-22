import type {
  ConversationRef,
  SendResult,
  TurnId,
  UserInput,
  QueuedInput,
  GramUIMessage,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { ActingPerson } from "../embedding/person.ts";

/** A client's input with no `waitNote`, which only the server sets. */
export const typedInput = (input: UserInput): UserInput => {
  const { waitNote, ...typed } = input;
  return waitNote === undefined ? input : typed;
};

/**
 * A client's input with none of what only the server sets: who wrote it (`author`), the thread
 * that sent it (`origin`), a notice card (`notice`), the note on Waiting on you (`waitNote`) and
 * the embedding host's conversation (`conversation`). Every RPC that takes a `UserInput` from a
 * client passes it through here first, so a person can't pass their words off as Gram's, another
 * thread's or an outside conversation's.
 */
export const clientInput = (input: UserInput): UserInput => {
  const {
    author: _author,
    origin: _origin,
    notice: _notice,
    waitNote: _waitNote,
    conversation: _conversation,
    ...typed
  } = input;
  return typed;
};

/** What of `stored` only the server sets, kept on an edit of it whatever the client sent. */
export const serverSetOf = (stored: UserInput): Partial<UserInput> => ({
  ...(stored.author === undefined ? {} : { author: stored.author }),
  ...(stored.origin === undefined ? {} : { origin: stored.origin }),
  ...(stored.notice === undefined ? {} : { notice: stored.notice }),
  ...(stored.waitNote === undefined ? {} : { waitNote: stored.waitNote }),
  ...(stored.conversation === undefined ? {} : { conversation: stored.conversation }),
});

/** A queued item put back after a send that didn't go: its turn was closed, and isn't reused. */
export const notInFlight = (item: QueuedInput): QueuedInput => {
  const { turnId: _, ...queued } = item;
  return queued;
};

/**
 * `input` given to `send` or `steer`, its `author` as the server establishes it: Gram's when it
 * carries a notice or its caller said so, the user's unless another thread sent it (`origin`).
 */
/** What `send` answers of how an input went: queued or not, and the turn it started. */
export const sendResultOf = (result: {
  readonly queued: boolean;
  readonly turnId?: TurnId | undefined;
}): SendResult =>
  result.turnId === undefined
    ? { queued: result.queued }
    : { queued: result.queued, turnId: result.turnId };

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
  ...(input.conversation === undefined
    ? []
    : [{ type: "data-conversation", id: messageId, data: input.conversation }]),
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

/**
 * `message` with who sent it (`metadata.sentBy`): the signed-in person this call is made for, on a
 * message a person typed. Unchanged where nobody is signed in, and for any other message.
 */
export const withSender = (message: GramUIMessage): Effect.Effect<GramUIMessage> =>
  Effect.map(ActingPerson, (person) =>
    person === undefined || message.metadata?.author !== "user"
      ? message
      : { ...message, metadata: { ...message.metadata, sentBy: person } },
  );

/**
 * The line the agent reads above a message an embedding host sent from one of its conversations:
 * where it came from, and how to answer there. A thread that doesn't own the conversation (another
 * one does) is told not to answer it itself.
 */
export const conversationHeader = (conversation: ConversationRef, owned: boolean): string => {
  const where =
    conversation.label === undefined
      ? `conversation ${conversation.id}`
      : `${conversation.label} (conversation ${conversation.id})`;
  return owned
    ? `[From ${where}. Answer there with the \`reply\` tool, naming this conversation; what you write in this chat isn't posted there.]`
    : `[From ${where}, which another thread answers. Don't reply there; pass on what matters with \`send_message\`.]`;
};
