import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";

import { cn } from "@/lib/utils";
import { Expand } from "@/motion";

import { ToolCard, type ToolCardProps } from "./tool-cards";
import { EditCounts } from "./file-edit-card";
import { runEdits, runState, runSummary, stepLabel } from "./tool-group-model";

/**
 * A run of tool calls folded into one line: what it did once it's finished ("Edited retry.ts, ran 2
 * commands +4 −1"), the step in flight while it isn't. Opening it shows each call's own card. Failures stay
 * countable on the closed line, and a run waiting on the user starts open.
 */
export function ToolGroup({
  run,
  ...card
}: { run: readonly ToolCardProps["part"][] } & Omit<ToolCardProps, "part">) {
  const { active, failed, cancelled, awaiting } = runState(run);
  const edits = runEdits(run);
  const [open, setOpen] = useState(awaiting);
  // Like a tool card's body: not laid out until first opened, then kept so closing animates.
  const [opened, setOpened] = useState(awaiting);
  const bodyId = useId();

  return (
    <div data-testid="tool-group" data-open={open} className="mb-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        className={cn(
          "flex max-w-full items-center gap-1 rounded-sm py-0.5 text-left text-sm outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
          active ? "text-foreground" : "text-muted-foreground",
        )}
        onClick={() => {
          setOpen(!open);
          setOpened(true);
        }}
      >
        <span className="truncate">{active ? `${stepLabel(active)}…` : runSummary(run)}</span>
        {!active && edits.length > 0 && (
          <>
            {" "}
            <EditCounts
              additions={edits.reduce((sum, edit) => sum + edit.additions, 0)}
              deletions={edits.reduce((sum, edit) => sum + edit.deletions, 0)}
            />
          </>
        )}
        {failed > 0 && (
          <span className="shrink-0 text-destructive">
            · {failed === 1 ? "1 failed" : `${failed} failed`}
          </span>
        )}
        {cancelled > 0 && <span className="shrink-0 text-warning">· {cancelled} cancelled</span>}
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-(--dur-fast)",
            open && "rotate-90",
          )}
        />
      </button>
      <Expand open={open} id={bodyId}>
        {opened && (
          <div className="pt-1.5">
            {run.map((part) => (
              <ToolCard key={part.toolCallId} part={part} {...card} />
            ))}
          </div>
        )}
      </Expand>
    </div>
  );
}
