import { ChevronRight, ShieldQuestion } from "lucide-react";
import { useId, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { useNow } from "@/lib/use-now";
import { Expand } from "@/motion";

import { ApprovalSlot, ApprovalSlotsOpen, useNeedsSlot } from "./approval-slots";
import { useAwaitingTools } from "./awaiting-tools";
import { MemoryWriteRow } from "./orchestration-cards";
import { ToolCard, type ToolCardProps } from "./tool-cards";
import { EditCounts } from "./file-edit-card";
import {
  runCalls,
  runEdits,
  runState,
  runSummary,
  stepLabel,
  turnFoldLabel,
  type RunPart,
  type TurnSummary,
} from "./tool-group-model";

/**
 * A run of tool calls folded into one line: what it did once it's finished ("Edited retry.ts, ran 2
 * commands +4 −1"), the step in flight while it isn't. Opening it shows each call's own card, and each
 * memory change among them as a row. Failures stay countable on the closed line, and a run waiting
 * on the user starts open.
 */
export function ToolGroup({
  run,
  ...card
}: { run: readonly RunPart[] } & Omit<ToolCardProps, "part">) {
  const { active, waiting, failed, cancelled, awaiting } = runState(run, useAwaitingTools());
  const edits = runEdits(run);
  // A run waiting on the user is open until the user says otherwise, even when the ask came later.
  const [toggled, setToggled] = useState<boolean>();
  const open = toggled ?? awaiting;
  // Like a tool card's body: not laid out until first opened, then kept so closing animates.
  const [everOpened, setOpened] = useState(false);
  const opened = everOpened || open;
  const bodyId = useId();
  // Closed, the run's line holds the card of the call it hides, or that card's receipt.
  const needsSlot = useNeedsSlot();
  const calls = runCalls(run);
  const hidden = open ? undefined : calls.find((part) => needsSlot(part.toolCallId));

  return (
    <div
      data-testid="tool-group"
      data-open={open}
      // Find in thread opens the group a match is in (find-highlight.ts).
      data-tool-call-ids={calls.map((part) => part.toolCallId).join(" ")}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        className={cn(
          "inline-flex max-w-full items-center gap-1 rounded-sm py-0.5 align-middle text-left text-reading outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
          active || waiting ? "text-foreground" : "text-muted-foreground",
        )}
        onClick={() => {
          setToggled(!open);
          setOpened(true);
        }}
      >
        {waiting !== undefined && (
          <ShieldQuestion aria-hidden className="size-icon-row shrink-0 text-status-needs-mark" />
        )}
        <span className="truncate">
          {waiting !== undefined
            ? `Waiting for your approval · ${stepLabel(waiting)}`
            : active
              ? `${stepLabel(active)}…`
              : runSummary(run)}
        </span>
        {!active && waiting === undefined && edits.length > 0 && (
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
        {cancelled > 0 && <span className="shrink-0">· {cancelled} cancelled</span>}
        <ChevronRight
          aria-hidden
          className={cn(
            "size-icon-chip shrink-0 transition-transform duration-(--dur-fast)",
            open && "rotate-90",
          )}
        />
      </button>
      {hidden !== undefined && <ApprovalSlot toolCallId={hidden.toolCallId} />}
      <Expand open={open} id={bodyId}>
        {opened && (
          <ApprovalSlotsOpen open={open}>
            <div className="flex flex-col gap-2 pt-1.5">
              {run.map((part, i) =>
                part.type === "data-memory-write" ? (
                  <MemoryWriteRow key={part.id ?? `memory:${i}`} write={part.data} />
                ) : (
                  <ToolCard key={part.toolCallId} part={part} {...card} />
                ),
              )}
            </div>
          </ApprovalSlotsOpen>
        )}
      </Expand>
    </div>
  );
}

/**
 * A turn folded to one row: how long it took and what it used. Opening it shows the turn as it
 * happened, under the row; failures stay countable on the closed line, as on `ToolGroup`'s.
 */
export function TurnFoldRow({
  turn,
  open,
  onToggle,
}: {
  turn: TurnSummary;
  open: boolean;
  onToggle: () => void;
}) {
  const running = turn.state === "running";
  const row = useRef<HTMLButtonElement>(null);
  const now = useNow(running, row);
  return (
    <button
      ref={row}
      type="button"
      data-testid="turn-fold"
      data-state={turn.state}
      aria-expanded={open}
      className={cn(
        "flex max-w-full items-center gap-1 self-start rounded-sm py-0.5 text-left text-reading outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
        running ? "text-foreground" : "text-muted-foreground",
      )}
      onClick={onToggle}
    >
      <span className="truncate">{turnFoldLabel(turn, now)}</span>
      {turn.failed > 0 && (
        <span className="shrink-0 text-destructive">
          · {turn.failed === 1 ? "1 failed" : `${turn.failed} failed`}
        </span>
      )}
      <ChevronRight
        aria-hidden
        className={cn(
          "size-icon-chip shrink-0 transition-transform duration-(--dur-fast)",
          open && "rotate-90",
        )}
      />
    </button>
  );
}
