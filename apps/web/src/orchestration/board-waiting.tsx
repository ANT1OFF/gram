import { waitViewOf, type WorkspaceState } from "@gram/contracts";
import { Link } from "@tanstack/react-router";

import { useApi } from "@/api/context";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { splitForTree } from "@/sidebar/grouping";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { useSame } from "@/stores/use-same";
import { byThread, keptWaits, trayViews, waitCount } from "@/thread/waiting-model";
import { WaitingItemRow } from "@/thread/waiting-tray";

import { useAskedQuestions } from "./ask-stack";
import { OpenQuestionList, WorkerQuestionList } from "./question-entry";
import { treeThreads, workspaceTrees } from "./tree-model";

// What waits on the user across a workspace, as the Board shows it:
// the orchestrator's own items and its open questions, the workers' questions forwarded to the
// user (docs/design/worker-questions.md), then each worker's items, a group to a thread. Requests
// are left to the ask stack, where they are answered.

export const WAITING_BAND = "board-waiting";

/**
 * What Waiting on you lists: the workspace's open questions, its workers' forwarded questions, and
 * its threads' items by thread, the orchestrator's first; `count` is what its chip and the band say.
 */
export function useBoardWaiting(state: WorkspaceState) {
  // The questions the stack still asks: one answered, held or set aside is gone from here too.
  const { questions, workerQuestions } = useAskedQuestions(state.workspace.id);
  const orchestratorId = useThreadsStore((s) =>
    state.workspace.orchestratorThreadId !== undefined &&
    s.byId[state.workspace.orchestratorThreadId] !== undefined
      ? state.workspace.orchestratorThreadId
      : undefined,
  );
  // Only the groups: a change to a thread with nothing waiting leaves the Board still.
  const groups = useThreadsStore(
    useSame(({ byId }) => {
      const ids = new Set<string>([state.workspace.id]);
      const [tree] = workspaceTrees([state], splitForTree(Object.values(byId), ids).tree);
      const threads = tree === undefined ? [] : treeThreads(tree);
      return byThread(
        threads.flatMap((summary) =>
          trayViews({ thread: summary.thread, waits: keptWaits(summary) }),
        ),
        threads.map((summary) => summary.thread.id),
      ).flatMap(({ threadId, views }) => {
        const summary = byId[threadId];
        return summary === undefined ? [] : [{ summary, views }];
      });
    }),
  );
  const count =
    questions.length +
    workerQuestions.length +
    groups.reduce((n, group) => n + waitCount(group.views), 0);
  return { questions, workerQuestions, orchestratorId, groups, count };
}

/** The band's items: the orchestrator's, its open questions answered in place, then each worker's with Done. */
export function WaitingList({
  state,
  waiting,
  shown,
  className,
}: {
  state: WorkspaceState;
  waiting: ReturnType<typeof useBoardWaiting>;
  /** Whether it is on screen, so its times tick only then. */
  shown: boolean;
  className?: string;
}) {
  const api = useApi();
  const now = useNow(shown, undefined, 60_000);
  const { questions, workerQuestions, orchestratorId, groups } = waiting;
  const own = groups.find((group) => group.summary.thread.id === orchestratorId);
  const workers = groups.filter((group) => group !== own);
  const rows = (group: (typeof groups)[number]) => (
    <ul className="flex flex-col gap-0.5">
      {keptWaits(group.summary).map((item) => (
        <WaitingItemRow
          key={item.id}
          threadId={group.summary.thread.id}
          view={waitViewOf(group.summary.thread.id, item)}
          item={item}
          now={now}
          elsewhere
          onDone={(done) =>
            void api
              .resolveWait(group.summary.thread.id, done.id)
              .catch((error: unknown) => console.error("waiting on you: done", error))
          }
        />
      ))}
    </ul>
  );
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {own !== undefined && (
        <div data-testid="board-waiting-group" data-thread={own.summary.thread.id}>
          {rows(own)}
        </div>
      )}
      {questions.length > 0 && (
        <OpenQuestionList
          questions={questions}
          workspaceId={state.workspace.id}
          orchestratorId={orchestratorId}
          compact
          className="grid grid-cols-[repeat(auto-fill,minmax(min(22rem,100%),1fr))] items-start gap-x-2"
        />
      )}
      {workerQuestions.length > 0 && (
        <WorkerQuestionList
          questions={workerQuestions}
          workspaceId={state.workspace.id}
          compact
          className="grid grid-cols-[repeat(auto-fill,minmax(min(22rem,100%),1fr))] items-start gap-x-2"
        />
      )}
      {workers.map((group) => (
        <div
          key={group.summary.thread.id}
          data-testid="board-waiting-group"
          data-thread={group.summary.thread.id}
        >
          <h4 className="truncate px-2 text-[11px] font-medium text-muted-foreground">
            <Link
              to="/t/$threadId"
              params={{ threadId: group.summary.thread.id }}
              onClick={() => useLayoutStore.getState().openThread(group.summary.thread.id)}
              className="hover:text-foreground hover:underline"
            >
              {group.summary.thread.title}
            </Link>
          </h4>
          {rows(group)}
        </div>
      ))}
    </div>
  );
}
