// Finished workers stay readable after their worktree is cleaned up. The sweep (or the user) closes
// a worker with its worktree; what Gram keeps of it then is all this reads, and it writes nothing:
//
// - while it is on the reopen list (`CLOSED_THREADS_LIMIT`), its record as closed, its conversation
//   (`closed_messages`) and its reports, which stay with it until it leaves that list;
// - after that, the workspace's transcript archive (`archive.ts`), a rendered, scrubbed transcript
//   whose heading names the worker and its feature.
//
// Its PR links come from the record's bindings, and its changed files from the edits in its
// conversation, summed per path. Nothing here reads git: the worktree is gone.

import {
  FINISHED_WORKER_MESSAGES_MAX,
  ThreadNotFound,
  briefOf,
  changedFilesOf,
  type ClosedThread,
  type FinishedWorker,
  type FinishedWorkerDetail,
  type FinishedWorkerPr,
  type Thread,
  type ThreadId,
  type WorkerReport,
  type WorkspaceId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";

import type { ThreadStore } from "../persistence/thread-store.ts";
import type { ThreadArchiveShape } from "./archive.ts";

/** The most archive-only workers the list reads the headings of, newest first. */
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

// The transcript readers live in contracts, where a live worker's peek reads them too.
export { briefOf, changedFilesOf };

const prUrl = (repo: string, number: number) => `https://github.com/${repo}/pull/${number}`;

/** The PRs a closed worker's record follows: its bound one first, then the others it bound. */
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

  /** The archive's workers no closed record or live thread covers, newest first, headings read. */
  const archivedOnly = (workspaceId: WorkspaceId, known: ReadonlySet<string>) =>
    Effect.gen(function* () {
      if (archive === undefined) return [];
      const listed = yield* archive.list(workspaceId).pipe(Effect.orElseSucceed(() => []));
      const found: Array<FinishedWorker> = [];
      for (const file of listed
        .filter((each) => !known.has(each.threadId))
        .slice(0, FINISHED_ARCHIVE_LIST_MAX)) {
        const text = yield* archive
          .read(workspaceId, file.threadId)
          .pipe(Effect.orElseSucceed(() => ""));
        const heading = archivedHeading(text);
        if (heading === undefined || heading.threadId !== file.threadId) continue;
        found.push({
          threadId: file.threadId as ThreadId,
          workspaceId,
          title: heading.title,
          feature: heading.feature,
          closedAt: file.archivedAt,
          prs: [],
          kept: "archived",
        });
      }
      return found;
    });

  const list = (workspaceId: WorkspaceId) =>
    Effect.gen(function* () {
      const reports = yield* reportsIn(workspaceId);
      const live = new Set<string>((yield* store.listThreads).map((thread) => thread.id));
      const closed = (yield* store.listClosed).flatMap((entry) => {
        if (live.has(entry.thread.id)) return [];
        const worker = closedWorkerOf(entry, workspaceId, reports.get(entry.thread.id)?.at(-1));
        return worker === undefined ? [] : [worker];
      });
      const known = new Set<string>([...live, ...closed.map((worker) => worker.threadId)]);
      const archived = yield* archivedOnly(workspaceId, known);
      return [...closed, ...archived].toSorted((a, b) => b.closedAt - a.closedAt);
    });

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

  /** A worker only the archive has: found through the workspaces' archives by its id. */
  const archivedDetail = (
    threadId: ThreadId,
  ): Effect.Effect<FinishedWorkerDetail, ThreadNotFound> =>
    Effect.gen(function* () {
      if (archive !== undefined) {
        const workspaces = (yield* store.listWorkspaces).map((state) => state.workspace.id);
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

  return { list, detail };
};
