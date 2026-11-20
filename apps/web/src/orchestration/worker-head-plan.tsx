import { Popover } from "@base-ui/react/popover";
import type { ThreadId } from "@gram/contracts";
import { ChevronDown, FolderGit2 } from "lucide-react";
import { useRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { useThreadsStore } from "@/stores/threads";
import { PlanStrip, stripShown, useStripFacts } from "@/thread/plan-strip";

import { workerHeadRepos, type WorkerHeadRepos } from "./board-model";
import { useOrchestratorLedger } from "./use-orchestration";

/**
 * A live worker's second head line in the right pane, under its state: the step it is on, with its
 * plan's bar and one count, that opens the whole plan; and at its right, always, the repositories it
 * works in, which for several open what follows the first one only. What the plan strip and the
 * multi-repo note said in rows of their own under the tools, said once and short. Absent when it
 * has neither to say.
 */
export function WorkerHeadPlan({ worker }: { worker: ThreadId }) {
  const facts = useStripFacts(worker);
  const repos = useHeadRepos(worker);
  const step = facts !== undefined && stripShown(facts) ? facts : undefined;
  const line = step?.state?.line;
  if (line === undefined && repos === undefined) return null;
  return (
    <div
      data-testid="beside-plan-line"
      className="flex min-w-0 items-center gap-2 pl-1 text-meta text-muted-foreground"
    >
      {step !== undefined && line !== undefined && (
        <PlanControl
          worker={worker}
          line={line}
          done={step.progress.done}
          total={step.progress.total}
        />
      )}
      {repos !== undefined && <Repos repos={repos} />}
    </div>
  );
}

/** The repositories the worker's ledger row names, else its checkouts' folders. */
function useHeadRepos(worker: ThreadId): WorkerHeadRepos | undefined {
  const summary = useThreadsStore((s) => s.byId[worker]);
  const { data: ledger } = useOrchestratorLedger(summary?.thread.workspaceId ?? undefined);
  if (summary === undefined || summary.git?.repo === false) return undefined;
  const entry = ledger?.features
    .flatMap((feature) => feature.workers)
    .find((each) => each.threadId === worker);
  return workerHeadRepos(summary.thread, entry);
}

const CONTROL =
  "flex h-6 min-w-0 items-center gap-1.5 rounded-sm px-1 -mx-1 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-accent data-[popup-open]:text-foreground";

const POPUP =
  "max-w-(--available-width) rounded-md border border-edge bg-popover text-popover-foreground shadow-overlay outline-none";

/** A popover from the head, below its trigger; Esc closes it and leaves the worker open. */
function HeadPopover({
  trigger,
  popupTestId,
  align,
  className,
  children,
}: {
  trigger: { testId: string; label: string; className?: string; content: ReactNode };
  popupTestId: string;
  align: "start" | "end";
  className: string;
  children: ReactNode;
}) {
  // The popup takes the keys as it opens, so none of its rows shows its hover actions yet.
  const popup = useRef<HTMLDivElement>(null);
  return (
    <Popover.Root>
      <Popover.Trigger
        data-testid={trigger.testId}
        aria-label={trigger.label}
        className={cn(CONTROL, trigger.className)}
      >
        {trigger.content}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align={align} sideOffset={4} className="isolate z-50">
          <Popover.Popup
            ref={popup}
            initialFocus={popup}
            data-testid={popupTestId}
            data-surface="overlay"
            className={cn(POPUP, className)}
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The step it is on, its bar and "Step 3 of 4"; a click or Enter opens the whole plan. */
function PlanControl({
  worker,
  line,
  done,
  total,
}: {
  worker: ThreadId;
  line: string;
  done: number;
  total: number;
}) {
  const at = Math.min(done + 1, total);
  const count = total > 0 ? `Step ${at} of ${total}` : undefined;
  return (
    <HeadPopover
      trigger={{
        testId: "beside-plan",
        label: `${line}${count === undefined ? "" : `, ${count.toLowerCase()}`}. Show the plan`,
        content: (
          <>
            {total > 0 && <PlanBar done={done} total={total} />}
            <span data-testid="beside-plan-step" className="min-w-0 truncate text-foreground/80">
              {line}
            </span>
            {count !== undefined && (
              <>
                <span aria-hidden className="shrink-0 text-subtle">
                  ·
                </span>
                <span data-testid="beside-plan-count" className="shrink-0 tabular-nums">
                  {count}
                </span>
              </>
            )}
            <ChevronDown aria-hidden className="size-icon-chip shrink-0" />
          </>
        ),
      }}
      popupTestId="beside-plan-popup"
      align="start"
      className="w-96"
    >
      <PlanStrip threadId={worker} inPopover />
    </HeadPopover>
  );
}

/** Its plan's steps as a short bar: the done ones filled, the one it is on in the primary colour. */
function PlanBar({ done, total }: { done: number; total: number }) {
  return (
    <span aria-hidden className="flex shrink-0 items-center gap-0.5">
      {Array.from({ length: Math.min(total, 8) }, (_, i) => (
        <span
          key={i}
          className={cn(
            "h-0.5 w-2 rounded-full",
            i < done ? "bg-muted-foreground" : i === done ? "bg-primary" : "bg-border",
          )}
        />
      ))}
    </span>
  );
}

/**
 * The repositories at the line's right: one by name; several as "api +2", which opens them all and
 * what follows the first one only, by click or by the keys.
 */
function Repos({ repos }: { repos: WorkerHeadRepos }) {
  const glyph = <FolderGit2 aria-hidden className="size-icon-chip shrink-0" />;
  if (repos.others.length === 0) {
    return (
      <span
        data-testid="beside-repos"
        className="ml-auto flex h-6 max-w-[40%] shrink-0 items-center gap-1"
      >
        {glyph}
        <span className="truncate">{repos.primary}</span>
      </span>
    );
  }
  const all = [repos.primary, ...repos.others];
  return (
    <HeadPopover
      trigger={{
        testId: "beside-repos",
        label: `Works in ${all.length} repositories: ${all.join(", ")}`,
        className: "ml-auto max-w-[40%] shrink-0",
        content: (
          <>
            {glyph}
            <span className="truncate">{repos.primary}</span>
            <span className="shrink-0 tabular-nums">+{repos.others.length}</span>
          </>
        ),
      }}
      popupTestId="beside-repos-popup"
      align="end"
      className="w-72 px-3 py-2.5 text-meta"
    >
      <p className="font-medium text-foreground">Works in {listed(all)}</p>
      <p className="mt-1 text-muted-foreground">
        Rewind, Changes and the review monitor follow {repos.primary} only.
      </p>
    </HeadPopover>
  );
}

/** "api, web and docs". */
const listed = (names: readonly string[]): string =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
