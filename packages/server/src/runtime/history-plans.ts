// Resuming, forking and rewinding a thread's agent session.

import {
  type AgentUnavailable,
  type Thread,
  type GramUIMessage,
  InvalidState,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import * as Clock from "effect/Clock";
import {
  locked,
  feedLocked,
  makeThreadId,
  type GetRuntime,
  type Runtime,
} from "./runtime-state.ts";
import { isRestartMarker } from "./session-restarts.ts";
import type { RewindPlan, ForkPlan, ThreadRuntimesShape } from "./thread-runtimes-shape.ts";
import { samePath } from "@gram/git";
import { copyForkedAttachments, attachmentsDir } from "../attachments/attachments.ts";
import type { ServerConfigShape } from "../config.ts";
import type { TurnLifecycle } from "./turn-lifecycle.ts";
import type { FeedWriter } from "./feed-writer.ts";

export interface ResumeOptions {
  readonly resumeId?: string;
  readonly fork?: boolean;
  readonly resumeAt?: string;
  readonly sessionId?: string;
  readonly codexHome?: NonNullable<Thread["codexHome"]>;
}

/**
 * Whether `messageId` was written before the thread's latest handoff, marker included. Such a
 * message's `agentMessageIds` belong to the agent session the handoff left behind, while
 * `Thread.agentSessionId` names the one that replaced it, so resuming or forking "at" it would ask
 * the new session for a message it never held.
 */
export const beforeHandoff = (
  messages: ReadonlyArray<GramUIMessage>,
  messageId: string,
): boolean => {
  const marker = messages.findLastIndex((message) =>
    message.parts.some((part) => part.type === "data-handoff"),
  );
  const at = messages.findIndex((message) => message.id === messageId);
  return marker >= 0 && at >= 0 && at <= marker;
};

export const BEFORE_HANDOFF =
  "that message is from before a session handoff, and the agent's current session doesn't hold it";

export const RESERVED_REWIND =
  "the thread is closing or its worktree is being cleaned up; rewind it after";

/** What resume planning reads: the thread's stored history. */
export interface ResumePlansDeps {
  readonly store: ThreadStoreShape;
}

/** How a thread's next session resumes its agent's conversation. */
export const makeResumePlans = ({ store }: ResumePlansDeps) => {
  /**
   * A thread resumes its own agent session, optionally at `resumeAt`. A session that never received
   * a message has no transcript, so it opens fresh under the same id. A fork without a used session
   * forks the source's session at `resumeAt` or the last message it copied.
   */
  const resumeOptions = (thread: Thread, resumeAt: string | undefined) =>
    Effect.gen(function* () {
      // A Codex session stays in the home it was first opened in.
      const home: ResumeOptions =
        thread.codexHome === undefined ? {} : { codexHome: thread.codexHome };
      if (thread.agentSessionId !== undefined && thread.agentSessionUnused !== true) {
        const options: ResumeOptions = {
          resumeId: thread.agentSessionId,
          ...(resumeAt === undefined ? {} : { resumeAt }),
          ...home,
        };
        return options;
      }
      const sameId: ResumeOptions = {
        ...(thread.agentSessionId === undefined ? {} : { sessionId: thread.agentSessionId }),
        ...home,
      };
      const source = thread.forkedFrom;
      if (source?.agentSessionId === undefined) return sameId;
      // A launch the agent hasn't had yet, as a reopen before its session ever ran it leaves, is in
      // the feed under its queue item's id; the source session has no such message.
      const unsent = new Set<string>((yield* store.listQueue(thread.id)).map((item) => item.id));
      const messages = (yield* store.listMessages(thread.id)).filter((m) => !unsent.has(m.id));
      const anchor =
        resumeAt ??
        messages.findLast((m) => !isRestartMarker(m))?.metadata?.agentMessageIds?.at(-1);
      // A fork runs in its source session's home.
      const options: ResumeOptions =
        anchor === undefined
          ? sameId
          : {
              resumeId: source.agentSessionId,
              fork: true,
              resumeAt: anchor,
              ...(thread.agentSessionId === undefined ? {} : { sessionId: thread.agentSessionId }),
              ...(source.codexHome === undefined ? {} : { codexHome: source.codexHome }),
            };
      return options;
    });

  return { resumeOptions };
};

/** What rewinding and forking read and change beside the stored history. */
export interface HistoryMethodsDeps {
  readonly store: ThreadStoreShape;
  readonly runtimes: ReadonlyMap<ThreadId, Runtime>;
  readonly config: ServerConfigShape;
  readonly getRuntime: GetRuntime;
  readonly stopSession: TurnLifecycle["stopSession"];
  readonly failUnavailable: TurnLifecycle["failUnavailable"];
  readonly publishUpsert: TurnLifecycle["publishUpsert"];
  readonly replaceFeed: FeedWriter["replaceFeed"];
  readonly openSession: (
    rt: Runtime,
    thread: Thread,
    resumeAt?: string,
    switchAttempt?: string,
  ) => Effect.Effect<void, AgentUnavailable>;
}

/** The `ThreadRuntimes` methods that rewind a thread or fork it at a message. */
export const makeHistoryMethods = ({
  store,
  runtimes,
  config,
  getRuntime,
  stopSession,
  failUnavailable,
  publishUpsert,
  replaceFeed,
  openSession,
}: HistoryMethodsDeps): Pick<
  ThreadRuntimesShape,
  "rewindTarget" | "rewind" | "forkTarget" | "fork"
> => ({
  rewindTarget: (threadId, messageId) =>
    Effect.gen(function* () {
      const thread = yield* store.getThread(threadId);
      const rt = yield* getRuntime(threadId);
      const invalid = (message: string) =>
        Effect.fail(new InvalidState({ message, threadId, status: rt.status }));
      // Before the handler restores any files: a rewind reopens the session, which neither a
      // close nor `whileAtRest` may have opened under it.
      if (rt.closing || rt.reserved) return yield* invalid(RESERVED_REWIND);
      if (
        yield* locked(
          rt,
          Effect.sync(() => rt.turn !== undefined || rt.status === "starting"),
        )
      ) {
        return yield* invalid("can't rewind while the agent is working");
      }
      const target = yield* store.getMessage(threadId, messageId);
      const turn = yield* store.getMessageTurn(threadId, messageId);
      if (target === undefined || turn === undefined) {
        return yield* invalid(`unknown message ${messageId}`);
      }
      let anchor =
        target.role === "user" ? yield* store.previousMessage(threadId, messageId) : target;
      // A restart's divider holds no agent message: the conversation resumes from before it.
      while (anchor !== undefined && target.role === "user" && isRestartMarker(anchor)) {
        anchor = yield* store.previousMessage(threadId, anchor.id);
      }
      const resumeAt = anchor?.metadata?.agentMessageIds?.at(-1);
      if (anchor !== undefined && resumeAt === undefined) {
        return yield* invalid("the agent can't resume at that message");
      }
      if (resumeAt !== undefined && thread.agentSessionId === undefined) {
        return yield* invalid("the thread has no agent session to rewind");
      }
      if (anchor !== undefined && beforeHandoff(yield* store.listMessages(threadId), anchor.id)) {
        return yield* invalid(BEFORE_HANDOFF);
      }
      const plan: RewindPlan = {
        messageId,
        role: target.role,
        turnId: turn.turnId,
        cwd: thread.checkout.path,
        resumeAt,
      };
      return plan;
    }),
  rewind: (threadId, plan, restoreFiles) =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      yield* store.getThread(threadId);
      const refused = new InvalidState({ message: RESERVED_REWIND, threadId, status: rt.status });
      if (rt.closing || rt.reserved) return yield* refused;
      yield* stopSession(rt, "rewind");
      yield* locked(
        rt,
        Effect.gen(function* () {
          if (rt.closing || rt.reserved) return yield* refused;
          if (rt.turn !== undefined) {
            return yield* new InvalidState({
              message: "can't rewind while the agent is working",
              threadId,
              status: rt.status,
            });
          }
          const thread = yield* feedLocked(
            rt,
            Effect.gen(function* () {
              const committed = yield* store.rewindThread(threadId, plan, restoreFiles);
              // No live feed/in-flight mutation until the whole store transaction commits.
              rt.open.clear();
              yield* replaceFeed(rt);
              return committed;
            }),
          );
          yield* openSession(rt, thread, plan.resumeAt).pipe(
            Effect.catchTag("AgentUnavailable", (e) => failUnavailable(rt, e)),
          );
        }),
      );
    }),
  forkTarget: (threadId, messageId) =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      const source = yield* store.getThread(threadId);
      const invalid = (message: string) =>
        Effect.fail(new InvalidState({ message, threadId, status: rt.status }));
      if (
        yield* locked(
          rt,
          Effect.sync(() => rt.turn !== undefined || rt.status === "starting"),
        )
      ) {
        return yield* invalid("can't fork while the agent is working");
      }
      const target =
        messageId === undefined
          ? (yield* store.listMessages(threadId)).findLast((m) => !isRestartMarker(m))
          : yield* store.getMessage(threadId, messageId);
      if (target === undefined) {
        return yield* invalid(
          messageId === undefined ? "there's nothing to fork yet" : `unknown message ${messageId}`,
        );
      }
      const resumeAt = target.metadata?.agentMessageIds?.at(-1);
      if (resumeAt === undefined) return yield* invalid("the agent can't resume at that message");
      if (source.agentSessionId === undefined) {
        return yield* invalid("the thread has no agent session to fork");
      }
      if (beforeHandoff(yield* store.listMessages(threadId), target.id)) {
        return yield* invalid(BEFORE_HANDOFF);
      }
      const turn = yield* store.getMessageTurn(threadId, target.id);
      const plan: ForkPlan = {
        source,
        messageId: target.id,
        role: target.role,
        turnId: turn?.turnId,
        resumeAt,
      };
      return plan;
    }),
  fork: (plan, { checkout, title }) =>
    Effect.gen(function* () {
      const { source } = plan;
      const inUse = [...runtimes.values()].some(
        (other) =>
          other.session !== undefined &&
          other.cwd !== undefined &&
          samePath(other.cwd, checkout.path),
      );
      if (inUse) {
        return yield* new InvalidState({
          message: "Fork into a new worktree: the source checkout is in use",
          threadId: source.id,
        });
      }
      const now = yield* Clock.currentTimeMillis;
      const thread: Thread = {
        id: makeThreadId(),
        projectId: source.projectId,
        title: title ?? `Fork of ${source.title}`,
        userNamed: title !== undefined,
        model: source.model,
        mode: source.mode,
        checkout,
        labels: [],
        pinned: false,
        parked: false,
        forkedFrom: {
          threadId: source.id,
          ...(source.agentSessionId === undefined ? {} : { agentSessionId: source.agentSessionId }),
          ...(source.codexHome === undefined ? {} : { codexHome: source.codexHome }),
        },
        unread: false,
        createdAt: now,
        lastActivityAt: now,
      };
      const stored = yield* store.insertThread(thread);
      const copies = yield* store.copyMessages(source.id, thread.id, plan.messageId);
      const owned = yield* copyForkedAttachments(
        attachmentsDir(config.dataDir),
        source.id,
        thread.id,
        copies,
      );
      for (const message of owned) yield* store.upsertMessage(thread.id, message);
      yield* publishUpsert(stored);
      return stored;
    }),
});

/** What `makeResumePlans` gives the rest of `ThreadRuntimes`. */
export type ResumePlans = ReturnType<typeof makeResumePlans>;
