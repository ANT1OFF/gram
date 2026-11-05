import type { ThreadId } from "@gram/contracts";
import { Check, ChevronRight, Circle } from "lucide-react";
import { Fragment } from "react";

import { agentLabel } from "@/agents/agent-label";
import { cn } from "@/lib/utils";
import { Spinner } from "@/motion/spinner";
import { tildify } from "@/new-thread/path";
import { useHome } from "@/new-thread/use-folder";
import { useThreadsStore } from "@/stores/threads";

import type { StartStep } from "./starting-progress-model";

/**
 * What a step reads as: its label, then its object. A worktree's folder is named for its branch,
 * so it reads as "Worktree" alone, its path on hover.
 */
function stepText(step: StartStep): string {
  if (step.detail === undefined || step.key === "worktree") return step.label;
  return `${step.label} ${step.detail}`;
}

/**
 * A fresh thread's start, in one row under the brief while nothing else is there: Branch ✓ ›
 * Worktree ✓ › Starting Claude Code ◌ › First tool. It goes once the agent's first output arrives;
 * `steps` (from `startingSteps`) is `undefined` then and the row isn't drawn.
 */
export function StartingProgress({
  threadId,
  steps,
}: {
  threadId: ThreadId;
  steps: readonly StartStep[];
}) {
  const home = useHome();
  const active = steps.find((step) => step.state === "active");
  const agent = useThreadsStore((s) => s.byId[threadId]?.thread.model.agent);
  return (
    <div data-testid="starting-progress" className="my-3 flex w-full flex-col gap-1">
      <span role="status" className="sr-only">
        {active === undefined ? "" : `${active.label}…`}
      </span>
      <ol
        aria-label={`Starting ${agentLabel(agent ?? "claude")}`}
        className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-meta"
      >
        {steps.map((step, index) => (
          <Fragment key={step.key}>
            {index > 0 && (
              <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground/70" />
            )}
            <li
              data-step={step.key}
              data-state={step.state}
              aria-current={step.state === "active" ? "step" : undefined}
              title={
                step.detail === undefined
                  ? undefined
                  : step.key === "worktree"
                    ? tildify(step.detail, home)
                    : step.detail
              }
              className={cn(
                "flex min-w-0 items-center gap-1",
                step.state === "pending" ? "text-muted-foreground/70" : "text-muted-foreground",
                step.state === "active" && "text-foreground",
              )}
            >
              {step.state === "done" ? (
                <Check aria-hidden className="size-3 shrink-0 text-success" />
              ) : step.state === "active" ? (
                <Spinner aria-hidden className="size-3 shrink-0 text-status-working" />
              ) : (
                <Circle aria-hidden className="size-3 shrink-0" />
              )}
              <span className="max-w-64 truncate">{stepText(step)}</span>
              <span className="sr-only">
                {step.state === "done" ? ", done" : step.state === "active" ? ", under way" : ""}
              </span>
            </li>
          </Fragment>
        ))}
      </ol>
    </div>
  );
}
