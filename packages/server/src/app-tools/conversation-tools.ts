import {
  AppToolError,
  autonomyOf,
  CONVERSATION_ID_MAX,
  CONVERSATION_REPLY_FILES_MAX,
  CONVERSATION_REPLY_MAX,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { attachmentsDir } from "../attachments/attachments.ts";
import { ServerConfig } from "../config.ts";
import { Conversations, type ConversationsShape } from "../embedding/conversations.ts";
import { readReplyFiles, type ReplyFile } from "../embedding/reply-files.ts";
import { ThreadStore, type ThreadStoreShape } from "../persistence/thread-store.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { defineAppTool } from "./definition.ts";
import type { SentFromMachines } from "./file-tools.ts";
import { AppToolRegistry } from "./registry.ts";
import { sentFromMachinesHere } from "./sent-from-machines.ts";

const supervised = (store: ThreadStoreShape, threadId: ThreadId) =>
  Effect.gen(function* () {
    const thread = yield* store.getThread(threadId);
    if (thread.profile?.autonomy === "supervised") return true;
    if (thread.workspaceId === undefined) return false;
    const state = yield* store.getWorkspace(thread.workspaceId);
    return autonomyOf(state.charter) === "supervised";
  }).pipe(Effect.orElseSucceed(() => true));

const replyFailed = (message: string) => new AppToolError({ tool: "reply", message });

const kilobytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 2 ** 20).toFixed(1)} MB`;

const filesWithoutBytes = (files: ReadonlyArray<ReplyFile>) =>
  files.map(({ name, mediaType, size, sha256 }) => ({ name, mediaType, size, sha256 }));

export const replyTool = (
  conversations: ConversationsShape,
  store: ThreadStoreShape,
  runtimes: Pick<ThreadRuntimesShape, "emitChunk"> | undefined,
  machines: SentFromMachines | undefined,
  attachments: string,
) =>
  defineAppTool({
    descriptor: {
      name: "reply",
      class: "self",
      description:
        "Post `text` in a conversation outside Gram that you own: one a message's header named as yours to answer (`[From … (conversation <id>)…]`), or one your orchestrator handed you. Name it by that id in `conversation`. Only `reply` reaches the people there; what you write in this chat doesn't. `files` sends files with it, such as a screenshot or a report, by path in the thread's folder (relative to it, or absolute inside it); copy a file there first to send it. Saying nothing is fine when nothing needs saying. Give `key` to make a retried call one reply.",
    },
    input: Schema.Struct({
      conversation: Schema.String.check(Schema.isMaxLength(CONVERSATION_ID_MAX)),
      text: Schema.String.check(Schema.isMaxLength(CONVERSATION_REPLY_MAX)),
      key: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
      files: Schema.optionalKey(
        Schema.Array(Schema.NonEmptyString).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(CONVERSATION_REPLY_FILES_MAX),
        ),
      ),
    }),
    rejectExcessProperties: true,
    resolve: (threadId, input) =>
      Effect.gen(function* () {
        if (input.files === undefined) return { ...input, files: [] as ReadonlyArray<ReplyFile> };
        const thread = yield* store
          .getThread(threadId)
          .pipe(Effect.mapError(() => replyFailed("That thread is gone.")));
        const files = yield* readReplyFiles(
          thread,
          input.files,
          machines,
          join(attachments, threadId),
        ).pipe(Effect.mapError(replyFailed));
        return { ...input, files };
      }),
    decision: (_threadId, target) => ({
      action: "conversation.reply",
      detail: {
        conversation: target.conversation,
        text: target.text,
        ...(target.files.length === 0 ? {} : { files: filesWithoutBytes(target.files) }),
      },
    }),
    needsApproval: (threadId) => supervised(store, threadId),
    describe: (_threadId, target) =>
      Effect.succeed(
        `Post in ${target.conversation}:\n\n${target.text}${
          target.files.length === 0
            ? ""
            : `\n\nWith ${target.files.map((each) => `${each.name} (${kilobytes(each.size)})`).join(", ")}`
        }`,
      ),
    handle: (threadId, target) =>
      Effect.gen(function* () {
        const { id, kept } = yield* conversations
          .reply(
            threadId,
            target.conversation,
            target.text,
            target.key ?? randomUUID(),
            target.files,
          )
          .pipe(Effect.mapError((e) => replyFailed(e.message)));
        if (runtimes !== undefined)
          for (const [index, each] of target.files.entries())
            yield* runtimes
              .emitChunk(threadId, {
                type: "file",
                url: pathToFileURL(kept[index] ?? each.path).href,
                mediaType: each.mediaType,
              })
              .pipe(Effect.ignore);
        return {
          sent: true,
          id,
          ...(target.files.length === 0
            ? {}
            : { files: target.files.map(({ name, size }) => ({ name, size })) }),
        };
      }),
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
    const runtimes = Option.getOrUndefined(yield* Effect.serviceOption(ThreadRuntimes));
    const machines = yield* sentFromMachinesHere;
    yield* registry.register([
      replyTool(conversations, store, runtimes, machines, attachmentsDir(config.dataDir)),
      takeConversationTool(conversations),
    ]);
  }),
);
