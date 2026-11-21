import * as Schema from "effect/Schema";

/** The longest a conversation's id is, in characters. */
export const CONVERSATION_ID_MAX = 200;
/** The longest a conversation's label is, in characters. */
export const CONVERSATION_LABEL_MAX = 120;
/** The most conversations one thread owns at once. */
export const CONVERSATIONS_PER_THREAD_MAX = 50;
/** The longest reply, as a message into a thread is. */
export const CONVERSATION_REPLY_MAX = 20_000;

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
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "`conversation` is `{ id, label? }`";
  const { id, label, ...rest } = value as Record<string, unknown>;
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
