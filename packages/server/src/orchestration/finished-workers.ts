import {
  briefOf,
  changedFilesOf,
  type ClosedThread,
  FINISHED_WORKER_MESSAGES_MAX,
  type FinishedWorker,
  type FinishedWorkerDetail,
  type FinishedWorkerPr,
  type FinishedWorkersCursor,
  type FinishedWorkersPage,
  type Thread,
  ThreadId,
  ThreadNotFound,
  type WorkerReport,
  type WorkspaceId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";

import type { ThreadStore } from "../persistence/thread-store.ts";
import type { ThreadArchiveShape } from "./archive.ts";
import { readableWorkspacesOnly } from "../embedding/readable-by.ts";

const FINISHED_ARCHIVE_LIST_MAX = 50;

/** The worker, feature and id an archived transcript's heading names, or nothing for another kind. */
export const archivedHeading = (
  text: string,
): { readonly title: string; readonly feature: string; readonly threadId: string } | undefined => {
  const head = text.slice(0, 2_000).split("\n");
  const title = head
    .find((line) => line.startsWith("# "))
    ?.slice(2)
    .trim();
  const source = /^Source: worker thread \((.+)\) (\S+)$/.exec(
    head.find((line) => line.startsWith("Source: ")) ?? "",
  );
  if (title === undefined || source === null) return undefined;
  return { title, feature: source[1]!, threadId: source[2]! };
};

const pastCursor = (
  file: { readonly archivedAt: number; readonly threadId: string },
  after: FinishedWorkersCursor | undefined,
): boolean =>
  after === undefined ||
  file.archivedAt < after.at ||
  (file.archivedAt === after.at && file.threadId > after.threadId);

export { briefOf, changedFilesOf };

const prUrl = (repo: string, number: number) => `https://github.com/${repo}/pull/${number}`;

const finishedPrs = (thread: Thread): ReadonlyArray<FinishedWorkerPr> => {
  const merged = thread.completedReason === "prMerged";
  return [
    ...(thread.boundPr === undefined
      ? []
      : [
          {
            repo: thread.boundPr.repo,
            number: thread.boundPr.number,
            url: prUrl(thread.boundPr.repo, thread.boundPr.number),
            ...(merged ? { merged: true as const } : {}),
          },
        ]),
    ...(thread.extraPrs ?? []).map((pr) => ({
      repo: pr.repo,
      number: pr.number,
      url: prUrl(pr.repo, pr.number),
    })),
  ];
};

const closedWorkerOf = (
  entry: ClosedThread,
  workspaceId: WorkspaceId,
  lastReport: WorkerReport | undefined,
): FinishedWorker | undefined => {
  const { thread } = entry;
  if (thread.spawnedBy === undefined || thread.workspaceId !== workspaceId) return undefined;
  return {
    threadId: thread.id,
    workspaceId,
    title: thread.title,
    feature: thread.spawnedBy.feature,
    orchestratorThreadId: thread.spawnedBy.threadId,
    closedAt: entry.closedAt,
    ...(thread.completedReason === undefined ? {} : { completedReason: thread.completedReason }),
    ...(lastReport === undefined ? {} : { lastReport }),
    prs: finishedPrs(thread),
    kept: "closed",
    agent: thread.model.agent,
  };
};

export interface FinishedWorkersDeps {
  readonly store: Pick<
    ThreadStore["Service"],
    "listClosed" | "listClosedMessages" | "listWorkerReports" | "listThreads" | "listWorkspaces"
  >;
  /** Absent where no archive is kept (runtime-only tests). */
  readonly archive: Pick<ThreadArchiveShape, "list" | "read"> | undefined;
}

export const makeFinishedWorkers = ({ store, archive }: FinishedWorkersDeps) => {
  const reportsIn = (workspaceId: WorkspaceId) =>
    Effect.map(store.listWorkerReports(workspaceId), (records) => {
      const byThread = new Map<ThreadId, Array<WorkerReport>>();
      for (const { report } of records) {
        const list = byThread.get(report.threadId) ?? [];
        list.push(report);
        byThread.set(report.threadId, list);
      }
      return byThread;
    });

  const archivedOnly = (
    workspaceId: WorkspaceId,
    known: ReadonlySet<string>,
    after: FinishedWorkersCursor | undefined,
  ) =>
    Effect.gen(function* () {
      if (archive === undefined) return { found: [], next: undefined };
      const listed = yield* archive.list(workspaceId).pipe(Effect.orElseSucceed(() => []));
      const rest = listed.filter((each) => !known.has(each.threadId) && pastCursor(each, after));
      const page = rest.slice(0, FINISHED_ARCHIVE_LIST_MAX);
      const found: Array<FinishedWorker> = [];
      for (const file of page) {
        const text = yield* archive
          .read(workspaceId, file.threadId)
          .pipe(Effect.orElseSucceed(() => ""));
        const heading = archivedHeading(text);
        if (heading === undefined || heading.threadId !== file.threadId) continue;
        found.push({
          threadId: ThreadId.make(file.threadId),
          workspaceId,
          title: heading.title,
          feature: heading.feature,
          closedAt: file.archivedAt,
          prs: [],
          kept: "archived",
        });
      }
      const last = page.at(-1);
      const next: FinishedWorkersCursor | undefined =
        rest.length > page.length && last !== undefined
          ? { at: last.archivedAt, threadId: last.threadId }
          : undefined;
      return { found, next };
    });

  const page = (
    workspaceId: WorkspaceId,
    after?: FinishedWorkersCursor,
  ): Effect.Effect<FinishedWorkersPage> =>
    Effect.gen(function* () {
      const live = new Set<string>((yield* store.listThreads).map((thread) => thread.id));
      const listedClosed = yield* store.listClosed;
      const reports = after === undefined ? yield* reportsIn(workspaceId) : undefined;
      const closed =
        reports === undefined
          ? []
          : listedClosed.flatMap((entry) => {
              if (live.has(entry.thread.id)) return [];
              const worker = closedWorkerOf(
                entry,
                workspaceId,
                reports.get(entry.thread.id)?.at(-1),
              );
              return worker === undefined ? [] : [worker];
            });
      const onList = listedClosed.flatMap((entry) => {
        const worker = closedWorkerOf(entry, workspaceId, undefined);
        return worker === undefined ? [] : [worker.threadId];
      });
      const known = new Set<string>([...live, ...onList]);
      const archived = yield* archivedOnly(workspaceId, known, after);
      return {
        workers: [...closed, ...archived.found].toSorted((a, b) => b.closedAt - a.closedAt),
        ...(archived.next === undefined ? {} : { next: archived.next }),
      };
    });

  const list = (workspaceId: WorkspaceId) =>
    Effect.map(page(workspaceId), (first) => first.workers);

  const detail = (threadId: ThreadId): Effect.Effect<FinishedWorkerDetail, ThreadNotFound> =>
    Effect.gen(function* () {
      const entry = (yield* store.listClosed).find((each) => each.thread.id === threadId);
      const workspaceId = entry?.thread.workspaceId;
      if (entry !== undefined && workspaceId !== undefined) {
        const reports = (yield* reportsIn(workspaceId)).get(threadId) ?? [];
        const worker = closedWorkerOf(entry, workspaceId, reports.at(-1));
        if (worker !== undefined) {
          const messages = yield* store.listClosedMessages(threadId);
          const kept = messages.slice(-FINISHED_WORKER_MESSAGES_MAX);
          const brief = briefOf(messages);
          return {
            worker,
            ...(brief === undefined ? {} : { brief }),
            reports,
            files: changedFilesOf(messages),
            messages: kept,
            earlierOmitted: messages.length - kept.length,
          } satisfies FinishedWorkerDetail;
        }
      }
      return yield* archivedDetail(threadId);
    });

  const archivedDetail = (
    threadId: ThreadId,
  ): Effect.Effect<FinishedWorkerDetail, ThreadNotFound> =>
    Effect.gen(function* () {
      if (archive !== undefined) {
        const workspaces = (yield* readableWorkspacesOnly(
          yield* store.listWorkspaces,
          (state) => state.workspace,
        )).map((state) => state.workspace.id);
        for (const workspaceId of workspaces) {
          const text = yield* archive.read(workspaceId, threadId).pipe(Effect.option);
          if (text._tag === "None") continue;
          const heading = archivedHeading(text.value);
          if (heading === undefined || heading.threadId !== threadId) continue;
          const listed = (yield* archive
            .list(workspaceId)
            .pipe(Effect.orElseSucceed(() => []))).find((file) => file.threadId === threadId);
          return {
            worker: {
              threadId,
              workspaceId,
              title: heading.title,
              feature: heading.feature,
              closedAt: listed?.archivedAt ?? 0,
              prs: [],
              kept: "archived",
            },
            reports: [],
            files: [],
            messages: [],
            earlierOmitted: 0,
            archived: text.value,
          } satisfies FinishedWorkerDetail;
        }
      }
      return yield* new ThreadNotFound({ threadId });
    });

  return { list, page, detail };
};
