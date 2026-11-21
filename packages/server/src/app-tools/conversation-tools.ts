import {
  AppToolError,
  autonomyOf,
  CONVERSATION_ID_MAX,
  CONVERSATION_REPLY_MAX,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import { ServerConfig } from "../config.ts";
import { Conversations, type ConversationsShape } from "../embedding/conversations.ts";
import { ThreadStore, type ThreadStoreShape } from "../persistence/thread-store.ts";
import { defineAppTool } from "./definition.ts";
import { AppToolRegistry } from "./registry.ts";

const supervised = (store: ThreadStoreShape, threadId: ThreadId) =>
  Effect.gen(function* () {
    const thread = yield* store.getThread(threadId);
    if (thread.profile?.autonomy === "supervised") return true;
    if (thread.workspaceId === undefined) return false;
    const state = yield* store.getWorkspace(thread.workspaceId);
    return autonomyOf(state.charter) === "supervised";
  }).pipe(Effect.orElseSucceed(() => true));

export const replyTool = (conversations: ConversationsShape, store: ThreadStoreShape) =>
  defineAppTool({
    descriptor: {
      name: "reply",
      class: "self",
      description:
        "Post `text` in a conversation outside Gram that you own: one a message's header named as yours to answer (`[From … (conversation <id>)…]`), or one your orchestrator handed you. Name it by that id in `conversation`. Only `reply` reaches the people there; what you write in this chat doesn't. Saying nothing is fine when nothing needs saying. Give `key` to make a retried call one reply.",
    },
    input: Schema.Struct({
      conversation: Schema.String.check(Schema.isMaxLength(CONVERSATION_ID_MAX)),
      text: Schema.String.check(Schema.isMaxLength(CONVERSATION_REPLY_MAX)),
      key: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
    }),
    rejectExcessProperties: true,
    needsApproval: (threadId) => supervised(store, threadId),
    describe: (_threadId, input) =>
      Effect.succeed(`Post in ${input.conversation}:\n\n${input.text}`),
    handle: (threadId, input) =>
      conversations.reply(threadId, input.conversation, input.text, input.key ?? randomUUID()).pipe(
        Effect.map(({ id }) => ({ sent: true, id })),
        Effect.mapError((e) => new AppToolError({ tool: "reply", message: e.message })),
      ),
  });

export const takeConversationTool = (conversations: ConversationsShape) =>
  defineAppTool({
    descriptor: {
      name: "take_conversation",
      class: "self",
      description:
        "Take back a conversation you handed one of your workers (`spawn_worker`'s `conversations`), by its id: your `reply` answers there again, and people's next messages there reach you. A closed worker's come back to you by themselves.",
    },
    audience: ["orchestrator"],
    input: Schema.Struct({
      conversation: Schema.String.check(Schema.isMaxLength(CONVERSATION_ID_MAX)),
    }),
    handle: (threadId, input) =>
      Effect.gen(function* () {
        const owner = yield* conversations.ownerOf(input.conversation);
        if (owner?.id === threadId) return { taken: false, owner: threadId };
        if (owner === undefined || owner.spawnedBy?.threadId !== threadId)
          return yield* new AppToolError({
            tool: "take_conversation",
            message: `None of your workers owns the conversation ${input.conversation}.`,
          });
        yield* conversations
          .hand(owner.id, threadId, [input.conversation])
          .pipe(
            Effect.mapError(
              (e) => new AppToolError({ tool: "take_conversation", message: e.message }),
            ),
          );
        return { taken: true, from: owner.id };
      }),
  });

/** Registers both where the server has a host to send replies to; provides nothing. */
export const ConversationAppToolsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const conversations = Option.getOrUndefined(yield* Effect.serviceOption(Conversations));
    if (config.eventSink === undefined || conversations === undefined) return;
    const registry = yield* AppToolRegistry;
    const store = yield* ThreadStore;
    yield* registry.register([
      replyTool(conversations, store),
      takeConversationTool(conversations),
    ]);
  }),
);
