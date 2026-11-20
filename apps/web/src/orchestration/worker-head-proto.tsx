import { Popover } from "@base-ui/react/popover";
import type { ThreadId } from "@gram/contracts";
import { ChevronDown, FolderGit2 } from "lucide-react";
import { useRef, type ReactNode } from "react";

import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";
import { useThreadsStore } from "@/stores/threads";
import { stripLine, stripSteps } from "@/thread/plan-model";
import { PlanRing, useThreadHeadline } from "@/thread/plan-ui";
import { PlanStrip } from "@/thread/plan-strip";

import { workerRepoNames } from "./board-model";
import { useOrchestratorLedger } from "./use-orchestration";

// PROTOTYPE ONLY (worker-head-trim, round 1): three ways to drop the plan strip and the multi-repo
// note under a worker's head in the right pane, for a blind rating. Dev builds only, chosen by
// `sessionStorage["gram.dev.workerHead"]` = "v1" | "v2" | "v3"; anything else draws today's head.

export type WorkerHeadVariant = "before" | "v1" | "v2" | "v3";

export const workerHeadVariant = (): WorkerHeadVariant => {
  if (!import.meta.env.DEV || typeof sessionStorage === "undefined") return "before";
  const value = sessionStorage.getItem("gram.dev.workerHead");
  return value === "v1" || value === "v2" || value === "v3" ? value : "before";
};

/** The repos a multi-repo worker works in, as its banner names them; undefined for one repo. */
export function useWorkerRepos(threadId: ThreadId) {
  const thread = useThreadsStore((s) => s.byId[threadId]?.thread);
  const { data: ledger } = useOrchestratorLedger(thread?.workspaceId ?? undefined);
  if (thread === undefined) return undefined;
  const entry = ledger?.features
    .flatMap((feature) => feature.workers)
    .find((worker) => worker.threadId === threadId);
  return workerRepoNames(thread, entry);
}

type Repos = NonNullable<ReturnType<typeof useWorkerRepos>>;

/** The caveat the banner said in a row of its own, for a hint. */
export const repoCaveat = (repos: Repos): string =>
  `Works in ${[repos.primary, ...repos.others].join(", ")}.\nRewind, Changes and the review monitor follow ${repos.primary} only.`;

/** What the worker is on now: the step in progress, else "Next: …". */
export function useStepLine(threadId: ThreadId): string | undefined {
  const plan = useThreadsStore((s) => s.byId[threadId]?.plan);
  const turnPlan = useThreadsStore((s) => s.plans[threadId]);
  return stripLine(stripSteps(plan, turnPlan).steps);
}

/** The plan, opened in a popover from what `trigger` draws in the head. */
export function PlanPopover({
  threadId,
  label,
  className,
  children,
}: {
  threadId: ThreadId;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  // The popup itself takes the keys, so no step's hover actions show as it opens.
  const popup = useRef<HTMLDivElement>(null);
  return (
    <Popover.Root>
      <Popover.Trigger
        data-testid="worker-head-plan"
        aria-label={label}
        className={cn(
          "flex min-w-0 items-center gap-1.5 rounded-sm px-1 -mx-1 text-meta text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        {children}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={4} className="isolate z-50">
          <Popover.Popup
            ref={popup}
            initialFocus={popup}
            data-surface="overlay"
            className="w-96 max-w-(--available-width) rounded-md border border-edge bg-popover text-popover-foreground shadow-overlay outline-none"
          >
            <PlanStrip threadId={threadId} inPopover />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** V3: the repos as a small chip on the state line, its caveat on hover. */
export function RepoChip({ repos }: { repos: Repos }) {
  return (
    <Hint
      label={repoCaveat(repos)}
      side="bottom"
      render={
        <span
          data-testid="worker-head-repos"
          tabIndex={0}
          className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-edge px-1.5 text-meta text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      }
    >
      <FolderGit2 aria-hidden className="size-icon-chip" />
      {repos.primary} +{repos.others.length}
    </Hint>
  );
}

/** V3: the step in progress in place of "Step N of M", its bar before it; the plan on a click. */
export function StepTitle({
  threadId,
  done,
  total,
}: {
  threadId: ThreadId;
  done: number;
  total: number;
}) {
  const line = useStepLine(threadId);
  const at = Math.min(done + 1, total);
  return (
    <PlanPopover
      threadId={threadId}
      label={`Step ${at} of ${total}${line === undefined ? "" : `: ${line}`}. Open the plan`}
      className="max-w-full"
    >
      <span aria-hidden className="flex shrink-0 items-center gap-0.5">
        {Array.from({ length: Math.min(total, 8) }, (_, i) => (
          <span
            key={i}
            className={cn(
              "h-0.5 w-1.5 rounded-full",
              i < done ? "bg-muted-foreground" : i === done ? "bg-primary" : "bg-border",
            )}
          />
        ))}
      </span>
      <span className="min-w-0 truncate text-foreground/80">
        {line ?? `Step ${at} of ${total}`}
      </span>
      <span className="shrink-0 tabular-nums">
        {at}/{total}
      </span>
    </PlanPopover>
  );
}

/**
 * V2: one quiet line in the head, only while it says something the state line doesn't: the step in
 * progress (a click opens the plan) and, for a multi-repo worker, its repos with the caveat on hover.
 */
export function WorkerAsideLine({ threadId }: { threadId: ThreadId }) {
  const repos = useWorkerRepos(threadId);
  const line = useStepLine(threadId);
  const { headline } = useThreadHeadline(threadId);
  const planned = headline !== undefined && headline.total > 0 && line !== undefined;
  if (!planned && repos === undefined) return null;
  return (
    <div
      data-testid="worker-head-aside"
      className="flex min-w-0 items-center gap-2 pl-1 text-meta text-muted-foreground"
    >
      {planned && (
        <PlanPopover threadId={threadId} label={`${line}. Open the plan`} className="min-w-0">
          <PlanRing
            headline={{
              phase: "next",
              done: headline.done,
              total: headline.total,
            }}
            className="shrink-0"
          />
          <span className="min-w-0 truncate">{line}</span>
          <ChevronDown aria-hidden className="size-icon-chip shrink-0" />
        </PlanPopover>
      )}
      {repos !== undefined && (
        <Hint
          label={repoCaveat(repos)}
          side="bottom"
          render={
            <span
              data-testid="worker-head-repos"
              tabIndex={0}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                planned && "ml-auto",
              )}
            />
          }
        >
          <FolderGit2 aria-hidden className="size-icon-chip" />
          {[repos.primary, ...repos.others].join(" + ")}
        </Hint>
      )}
    </div>
  );
}
