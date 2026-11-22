import {
  type ConversationRef,
  CONVERSATIONS_PER_THREAD_MAX,
  CONVERSATION_REPLY_MAX,
  embeddingOn,
  InvalidState,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { createHash } from "node:crypto";
import { ServerConfig } from "../config.ts";
import { EventHub, isThreadRemoved } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { EventSink } from "./event-sink.ts";
import { keepReplyFiles, type ReplyFile } from "./reply-files.ts";

/** What a reply hears where the server has no host to send it to. */
export const NO_HOST = "This server sends no replies: it has no embedding host's event sink.";

const refuse = (message: string) => new InvalidState({ message });

export interface ConversationsShape {
  /** Whether replies can go anywhere: hosted features on and an event sink configured. */
  readonly on: Effect.Effect<boolean>;
  /**
   * The host sent `threadId` a message from `conversation`: the thread owns it now, unless another
   * open thread does. Answers the owner.
   */
  readonly arrive: (threadId: ThreadId, conversation: ConversationRef) => Effect.Effect<ThreadId>;
  /** The open thread that owns conversation `id`, if one does. */
  readonly ownerOf: (id: string) => Effect.Effect<Thread | undefined>;
  /**
   * Moves the conversations `ids` from `from`, which must own each, to `to`. Refused, with
   * nothing moved, when `from` owns one of them not, or `to` would own too many.
   */
  readonly hand: (
    from: ThreadId,
    to: ThreadId,
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<void, InvalidState>;
  /**
   * Sends `text`, and `files` with it, to conversation `id` through the host, as `threadId`, which
   * must own it. `key` makes the reply's id, so a call sent again is one reply. The files are kept
   * for the host to read back by the reply's id (`/embed/v1/conversation-files`).
   */
  readonly reply: (
    threadId: ThreadId,
    id: string,
    text: string,
    key: string,
    files?: ReadonlyArray<ReplyFile>,
  ) => Effect.Effect<{ readonly id: string; readonly kept: ReadonlyArray<string> }, InvalidState>;
}

const owns = (thread: Pick<Thread, "conversations">, id: string) =>
  (thread.conversations ?? []).some((each) => each.id === id);

export class Conversations extends Context.Service<Conversations, ConversationsShape>()(
  "@gram/server/Conversations",
) {
  static readonly layer: Layer.Layer<
    Conversations,
    never,
    ThreadStore | ThreadRuntimes | EventSink | EventHub | ServerConfig
  > = Layer.effect(
    Conversations,
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const runtimes = yield* ThreadRuntimes;
      const sink = yield* EventSink;
      const hub = yield* EventHub;
      const config = yield* ServerConfig;
      const lock = yield* Semaphore.make(1);

      const on = Effect.map(
        store.getSettings,
        (settings) => embeddingOn(settings) && config.eventSink !== undefined,
      );

      const ownerOf: ConversationsShape["ownerOf"] = (id) =>
        Effect.map(store.listThreads, (threads) => threads.find((thread) => owns(thread, id)));

      const told = (conversation: string, owner: ThreadId | undefined) =>
        sink.record({
          type: "conversation.owner",
          ...(owner === undefined ? {} : { threadId: owner }),
          data: { conversation, ...(owner === undefined ? {} : { owner }) },
        });

      const update = (
        threadId: ThreadId,
        f: (list: ReadonlyArray<ConversationRef>) => ReadonlyArray<ConversationRef>,
      ) =>
        runtimes.updateThread(threadId, (thread) => {
          const next = f(thread.conversations ?? []);
          const { conversations: _, ...rest } = thread;
          return next.length === 0 ? rest : { ...rest, conversations: [...next] };
        });

      const arrive: ConversationsShape["arrive"] = (threadId, conversation) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const owner = yield* ownerOf(conversation.id);
            if (owner !== undefined) {
              if (owner.id === threadId && conversation.label !== undefined)
                yield* update(threadId, (list) =>
                  list.map((each) => (each.id === conversation.id ? conversation : each)),
                ).pipe(Effect.ignore);
              return owner.id;
            }
            const thread = yield* store.getThread(threadId).pipe(Effect.option);
            if (
              Option.isNone(thread) ||
              (thread.value.conversations ?? []).length >= CONVERSATIONS_PER_THREAD_MAX
            )
              return threadId;
            yield* update(threadId, (list) => [...list, conversation]).pipe(Effect.ignore);
            yield* told(conversation.id, threadId);
            return threadId;
          }),
        );

      const hand: ConversationsShape["hand"] = (from, to, ids) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            if (ids.length === 0) return;
            const source = yield* store
              .getThread(from)
              .pipe(Effect.mapError(() => refuse("That thread is gone.")));
            const target = yield* store
              .getThread(to)
              .pipe(Effect.mapError(() => refuse("That thread is gone.")));
            const moving = [...new Set(ids)].map((id) =>
              (source.conversations ?? []).find((each) => each.id === id),
            );
            const missing = ids.filter((_, i) => moving[i] === undefined);
            if (missing.length > 0)
              return yield* refuse(
                `You don't own the conversation ${missing.join(", ")}, so it can't be handed on.`,
              );
            const refs = moving as ReadonlyArray<ConversationRef>;
            if ((target.conversations ?? []).length + refs.length > CONVERSATIONS_PER_THREAD_MAX)
              return yield* refuse(
                `A thread owns at most ${CONVERSATIONS_PER_THREAD_MAX} conversations.`,
              );
            const gone = new Set(refs.map((ref) => ref.id));
            yield* update(from, (list) => list.filter((each) => !gone.has(each.id))).pipe(
              Effect.mapError((e) => refuse(e.message)),
            );
            yield* update(to, (list) => [...list, ...refs]).pipe(
              Effect.mapError((e) => refuse(e.message)),
            );
            for (const ref of refs) yield* told(ref.id, to);
          }),
        );

      const reply: ConversationsShape["reply"] = (threadId, id, text, key, files = []) =>
        Effect.gen(function* () {
          if (!(yield* on)) return yield* refuse(NO_HOST);
          if (text.trim() === "" || text.length > CONVERSATION_REPLY_MAX)
            return yield* refuse(`A reply is 1 to ${CONVERSATION_REPLY_MAX} characters.`);
          const thread = yield* store
            .getThread(threadId)
            .pipe(Effect.mapError(() => refuse("That thread is gone.")));
          if (!owns(thread, id))
            return yield* refuse(
              `This thread doesn't own the conversation ${id}, so it can't reply there. Reply only in a conversation a message came to you from, or one you were handed.`,
            );
          const replyId = createHash("sha256")
            .update(`${threadId}\0${id}\0${key}`)
            .digest("hex")
            .slice(0, 32);
          const kept = yield* keepReplyFiles(config.dataDir, replyId, files).pipe(
            Effect.mapError(refuse),
          );
          yield* sink.record({
            type: "conversation.reply",
            threadId,
            ...(thread.workspaceId === undefined ? {} : { workspaceId: thread.workspaceId }),
            data: {
              id: replyId,
              conversation: id,
              text,
              ...(files.length === 0
                ? {}
                : {
                    files: files.map(({ name, mediaType, size, sha256 }) => ({
                      name,
                      mediaType,
                      size,
                      sha256,
                    })),
                  }),
            },
          });
          return { id: replyId, kept };
        });

      yield* hub.internalEvents(isThreadRemoved, "conversations").pipe(
        Stream.runForEach(({ threadId }) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const closed = (yield* store.listClosed).find((each) => each.thread.id === threadId);
              const left = closed?.thread.conversations ?? [];
              if (left.length === 0) return;
              const parent = closed?.thread.spawnedBy?.threadId;
              const back =
                parent === undefined
                  ? undefined
                  : Option.getOrUndefined(yield* store.getThread(parent).pipe(Effect.option));
              if (back !== undefined) {
                const room = CONVERSATIONS_PER_THREAD_MAX - (back.conversations ?? []).length;
                const taken = left
                  .filter((each) => !owns(back, each.id))
                  .slice(0, Math.max(0, room));
                if (taken.length > 0)
                  yield* update(back.id, (list) => [...list, ...taken]).pipe(Effect.ignore);
                for (const each of left)
                  yield* told(each.id, taken.includes(each) ? back.id : undefined);
                return;
              }
              for (const each of left) yield* told(each.id, undefined);
            }),
          ),
        ),
        Effect.forkScoped,
      );

      return { on, arrive, ownerOf, hand, reply };
    }),
  );
}
