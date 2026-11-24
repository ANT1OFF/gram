import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";

/** The longest a conversation's id is, in characters. */
export const CONVERSATION_ID_MAX = 200;
/** The longest a conversation's label is, in characters. */
export const CONVERSATION_LABEL_MAX = 120;
/** The most conversations one thread owns at once. */
export const CONVERSATIONS_PER_THREAD_MAX = 50;
/** The longest reply, as a message into a thread is. */
export const CONVERSATION_REPLY_MAX = 20_000;
/** The most files one reply carries. */
export const CONVERSATION_REPLY_FILES_MAX = 10;
/** The most one reply's files come to together, in bytes. */
export const CONVERSATION_REPLY_FILES_BYTES_MAX = 25 * 2 ** 20;
/** The most files one message from a host carries. */
export const THREAD_MESSAGE_ATTACHMENTS_MAX = 10;
/** The most one message's files from a host come to together, in decoded bytes. */
export const THREAD_MESSAGE_ATTACHMENTS_BYTES_MAX = 32 * 2 ** 20;

/**
 * One file a reply carries, as `conversation.reply` names it and the decision hook is asked about
 * it: the host reads its bytes from `/embed/v1/conversation-files` and checks them by `sha256`.
 */
export const ConversationReplyFile = Schema.Struct({
  name: Schema.String,
  mediaType: Schema.String,
  size: Schema.Int,
  /** Lowercase hex SHA-256 of the bytes. */
  sha256: Schema.String,
});
export type ConversationReplyFile = typeof ConversationReplyFile.Type;

/** A conversation's id: printable, with no space, as the host makes it. */
export const CONVERSATION_ID = /^[\x21-\x7e]{1,200}$/;

export const ConversationRef = Schema.Struct({
  /** The host's own id for the conversation, opaque here. */
  id: Schema.String.check(Schema.isPattern(CONVERSATION_ID)),
  /** Where it is, for a person reading the transcript and for the agent: `Slack · #runbooks`. */
  label: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(CONVERSATION_LABEL_MAX))),
});
export type ConversationRef = typeof ConversationRef.Type;

/** Why `value` isn't a conversation reference a host may give, or `undefined` when it is one. */
export const conversationRefProblem = (value: unknown): string | undefined => {
  if (!Predicate.isObject(value)) return "`conversation` is `{ id, label? }`";
  const { id, label, ...rest } = value;
  if (Object.keys(rest).length > 0) return "`conversation` takes only `id` and `label`";
  if (typeof id !== "string" || !CONVERSATION_ID.test(id))
    return `\`conversation.id\` is 1 to ${CONVERSATION_ID_MAX} printable characters, with no space`;
  if (
    label !== undefined &&
    (typeof label !== "string" || label.trim() === "" || label.length > CONVERSATION_LABEL_MAX)
  )
    return `\`conversation.label\` is 1 to ${CONVERSATION_LABEL_MAX} characters`;
  return undefined;
};
