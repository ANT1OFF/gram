import type { DreamPlan, Thread, WorkspaceId, WorkspaceState } from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { readableByOfWorkspace, readerMay } from "../embedding/readable-by.ts";
import { DREAM_CURSOR_START, type DreamCursor } from "../persistence/dream-cursor.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import {
  ADOPTION_SLACK_MS,
  latestRecap,
  RECAP_LOOKBACK_MESSAGES,
  recentRead,
  type RecentItem,
} from "./dream-recent.ts";
import type { OrchestrationMemoryShape } from "./memory.ts";
import { readOutbox } from "./outbox.ts";
import { questionsOf } from "./worker-questions.ts";

/**
 * A thread whose finish a memory update reads: a worker or conversation of the workspace marked
 * complete by its agent or the user, or by its merged pull request. A reply ending or going idle
 * is not a finish; memory update and orchestrator threads and helpers never count.
 */
export const eligibleCompletion = (thread: Thread, state: WorkspaceState): boolean =>
  thread.role === undefined &&
  state.workspace.projectIds.includes(thread.projectId) &&
  (thread.spawnedBy === undefined || thread.workspaceId === state.workspace.id) &&
  thread.completedAt !== undefined &&
  (thread.completedReason === "agent" ||
    thread.completedReason === "user" ||
    thread.completedReason === "prMerged");

const cursorOfStore = (store: ThreadStoreShape, workspaceId: WorkspaceId) =>
  store.getDreamCursor(workspaceId).pipe(Effect.map((cursor) => cursor ?? DREAM_CURSOR_START));

const finishedSince = (
  state: WorkspaceState,
  cursor: DreamCursor,
  open: ReadonlyArray<Thread>,
  closed: ReadonlyArray<Thread>,
): ReadonlyArray<Thread> => {
  const reader = {
    subject: readableByOfWorkspace(state.workspace.id, state.workspace.orchestratorThreadId),
  };
  const live = new Set<string>(open.map((thread) => thread.id));
  return [...open, ...closed.filter((one) => !live.has(one.id))].filter(
    (thread) =>
      eligibleCompletion(thread, state) &&
      thread.completedAt! > cursor.at &&
      readerMay(reader, thread.readableBy),
  );
};

const answeredSince = (outbox: Parameters<typeof questionsOf>[0], cursor: DreamCursor) =>
  questionsOf(outbox).filter(
    (question) =>
      question.answer !== undefined &&
      question.closedAt !== undefined &&
      question.closedAt > cursor.at &&
      question.withdrawal === undefined,
  );

/**
 * What has happened worth remembering since a workspace's last memory update, counted from its
 * cursor without reading a transcript or calling a model: worker reports that say what they learned,
 * merges, answered questions and finished threads. Progress reports without a lesson are left out:
 * they are status, many to a thread, and the thread's finish and recap already stand for them.
 */
export interface MemoryActivity {
  readonly learned: number;
  readonly merges: number;
  readonly questions: number;
  readonly threads: number;
  readonly total: number;
}

export const countActivity = (store: ThreadStoreShape, state: WorkspaceState) =>
  Effect.gen(function* () {
    const workspaceId = state.workspace.id;
    const cursor = yield* cursorOfStore(store, workspaceId);
    const learned = (yield* store.listWorkerReports(workspaceId, cursor.reportSeq)).filter(
      ({ report }) => (report.learned?.trim() ?? "") !== "",
    ).length;
    const merges = (yield* store.listOrchestrationEventsAfter(workspaceId, cursor.eventSeq, [
      "merge",
    ])).length;
    const questions = answeredSince(
      readOutbox(yield* store.getOutbox(workspaceId)).state,
      cursor,
    ).length;
    const threads = finishedSince(
      state,
      cursor,
      yield* store.listThreads,
      (yield* store.listClosed).map((entry) => entry.thread),
    ).length;
    return {
      learned,
      merges,
      questions,
      threads,
      total: learned + merges + questions + threads,
    } satisfies MemoryActivity;
  });

/**
 * What a memory update would read of a workspace now, counted, and the file it reads: everything
 * past its cursor (worker reports, merges, answered questions, finished threads with their recaps,
 * memory notes written since), each from what Gram already keeps. Nothing here opens a transcript.
 */
export const makePlanRecent = (store: ThreadStoreShape, memory: OrchestrationMemoryShape) => {
  const recentItems = (state: WorkspaceState, cursor: DreamCursor) =>
    Effect.gen(function* () {
      const workspaceId = state.workspace.id;
      const items: Array<RecentItem> = [];
      const open = yield* store.listThreads;
      const closed = (yield* store.listClosed).map((entry) => entry.thread);
      const titles = new Map<string, string>(
        [...closed, ...open].map((thread) => [thread.id, thread.title]),
      );
      const titleOf = (threadId: string) => titles.get(threadId) ?? `thread ${threadId}`;
      for (const { seq, report } of yield* store.listWorkerReports(workspaceId, cursor.reportSeq)) {
        items.push({
          kind: "report",
          seq,
          at: report.at,
          title: titleOf(report.threadId),
          report,
        });
      }
      for (const event of yield* store.listOrchestrationEventsAfter(workspaceId, cursor.eventSeq, [
        "merge",
      ])) {
        const data = (event.data ?? {}) as {
          readonly threadId?: unknown;
          readonly pr?: unknown;
        };
        const threadId = typeof data.threadId === "string" ? data.threadId : undefined;
        items.push({
          kind: "merge",
          seq: event.seq,
          at: event.at,
          pr: typeof data.pr === "string" ? data.pr : "a pull request",
          ...(threadId === undefined ? {} : { threadId, title: titleOf(threadId) }),
        });
      }
      const outbox = readOutbox(yield* store.getOutbox(workspaceId)).state;
      for (const question of answeredSince(outbox, cursor)) {
        items.push({
          kind: "question",
          at: question.closedAt!,
          id: question.id,
          title: question.title,
          threadId: question.threadId,
          question: question.question,
          answer: question.answer!,
          by: question.closedBy === "orchestrator" ? "orchestrator" : "user",
        });
      }
      const live = new Set<string>(open.map((thread) => thread.id));
      for (const thread of finishedSince(state, cursor, open, closed)) {
        const recap = live.has(thread.id)
          ? latestRecap(yield* store.lastMessages(thread.id, RECAP_LOOKBACK_MESSAGES))
          : latestRecap(
              (yield* store.listMessagesFrom(
                thread.id,
                (yield* store.messageMarks(thread.id, true)).at(-RECAP_LOOKBACK_MESSAGES)?.seq ?? 0,
                true,
              )).map((row) => row.message),
            );
        items.push({
          kind: "thread",
          at: thread.completedAt!,
          title: thread.title,
          threadId: thread.id,
          reason: thread.completedReason ?? "completed",
          ...(recap === undefined ? {} : { recap }),
        });
      }
      const adoptedAt =
        (yield* memory.versions(workspaceId).pipe(Effect.orElseSucceed(() => []))).find(
          (version) => version.current,
        )?.adoptedAt ?? 0;
      for (const file of yield* memory.list(workspaceId).pipe(Effect.orElseSucceed(() => []))) {
        if (file.modifiedAt <= cursor.at || file.modifiedAt <= adoptedAt + ADOPTION_SLACK_MS)
          continue;
        items.push({ kind: "memory", at: file.modifiedAt, path: file.path });
      }
      return items;
    });

  const planRecent = (state: WorkspaceState, version: string) =>
    Effect.gen(function* () {
      const cursor = yield* cursorOfStore(store, state.workspace.id);
      const items = yield* recentItems(state, cursor);
      const recent = recentRead(items, cursor, yield* Clock.currentTimeMillis);
      const plan: DreamPlan = {
        memoryVersion: version,
        sinceAt: recent.read.sinceAt,
        reports: recent.read.reports,
        merges: recent.read.merges,
        questions: recent.read.questions,
        threads: recent.read.threads,
        estimatedTokens: recent.read.estimatedTokens,
        ...(recent.read.more === true ? { more: true } : {}),
      };
      return { recent, plan };
    });
  return planRecent;
};
