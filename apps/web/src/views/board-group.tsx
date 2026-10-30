import type { FeatureStage, WorkspaceId } from "@gram/contracts";
import { ChevronRight, CircleAlert, Layers, Pencil } from "lucide-react";
import { useId, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import type { RowPlace } from "@/lib/virtual-rows";
import { Expand, ExpandPresence } from "@/motion";
import { groupFolded, groupFoldKey, type RailGroup } from "@/orchestration/rail-model";
import { StageEditor } from "@/orchestration/stage-editor";
import type { StageTarget } from "@/orchestration/stage-model";
import { StageChip, StageStepper } from "@/orchestration/stage-stepper";
import type { useSetStage } from "@/orchestration/use-board-actions";
import { useLayoutStore } from "@/stores/layout";
import { StatePill } from "@/thread/orchestration-cards";
import { presentState } from "@/thread/orchestration-model";

// A feature's or a group's stage on the Board: the current stage as
// a chip, its note and who set it in the tooltip, with the plan's steps as pips a click sets; and a
// group's band over its lines, folded.

export type SetStage = ReturnType<typeof useSetStage>;

/** Whether the stage is a step of a plan, which the pips can show. */
const planned = (stage: FeatureStage) => stage.plan?.includes(stage.stage) === true;

/** The stage under a feature's name or beside a group's: a chip, then the plan's pips. */
export function StageLine({
  stage,
  subject,
  target,
  setStage,
  testId,
  className,
}: {
  stage: FeatureStage;
  subject: string;
  target: StageTarget;
  setStage: SetStage | undefined;
  testId: string;
  className?: string;
}) {
  return (
    <span data-testid={testId} className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <StageChip stage={stage} testId={`${testId}-chip`} className="shrink-0" />
      {planned(stage) && (
        <StageStepper
          stage={stage}
          subject={subject}
          compact
          bare
          className="max-w-24 min-w-10 flex-1"
          onSelect={
            setStage === undefined
              ? undefined
              : (name) => {
                  if (name !== stage.stage) void setStage(target, { stage: name });
                }
          }
        />
      )}
    </span>
  );
}

const ROW_ACTION =
  "inline-flex shrink-0 items-center gap-1 rounded-sm text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Several features run as one effort: a band over their lines with the state and the stage of the
 * whole, which folds them away. It says once that the group needs you, in its state or a mark beside
 * it; its lines don't say it again. A finished group starts folded to one line; either way the fold is
 * remembered per workspace.
 */
export function GroupBand({
  workspaceId,
  group,
  setStage,
  editing,
  onEditingChange,
  place,
  children,
}: {
  workspaceId: WorkspaceId;
  group: RailGroup;
  setStage: SetStage;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  /** Where the Board's list draws it. */
  place?: RowPlace | undefined;
  children: ReactNode;
}) {
  const key = groupFoldKey(workspaceId, group);
  const listed = useLayoutStore((s) => s.workspacesCollapsedNodes.includes(key));
  const folded = groupFolded(group, listed);
  const linesId = useId();
  const count = group.rows.length;
  const target: StageTarget = { group: group.group };
  const state = group.state === undefined ? undefined : presentState(group.state);
  const needs = state?.tone !== "needs" && group.rows.some((row) => row.needs);
  return (
    <li
      ref={place?.ref}
      data-index={place?.["data-index"]}
      style={place?.style}
      className={place?.className}
      data-testid="rail-group"
      data-group={group.group}
      data-folded={folded}
      data-finished={group.finished || undefined}
      aria-label={`Group ${group.group}`}
    >
      <div
        className={cn(
          "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 bg-card/40 px-4",
          folded ? "py-1.5" : "py-2",
        )}
      >
        <button
          type="button"
          data-testid="rail-group-toggle"
          aria-expanded={!folded}
          aria-controls={linesId}
          onClick={() => useLayoutStore.getState().toggleWorkspaceNode(key)}
          className="flex min-w-0 items-center gap-1.5 rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--dur-fast)",
              !folded && "rotate-90",
            )}
          />
          <Layers aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className={cn("min-w-0 truncate", group.finished && "text-muted-foreground")}>
            {group.group}
          </span>
        </button>
        {state !== undefined && <StatePill state={state} testId="rail-group-state" />}
        {needs && (
          <CircleAlert
            aria-label="Needs you"
            data-testid="rail-needs"
            className="size-3 shrink-0 text-status-needs"
          />
        )}
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {count} {count === 1 ? "feature" : "features"}
        </span>
        {group.stage !== undefined && (
          <StageLine
            stage={group.stage}
            subject={group.group}
            target={target}
            setStage={folded ? undefined : setStage}
            testId="rail-group-stage"
            className="max-w-64"
          />
        )}
        {!folded && (
          <button
            type="button"
            data-testid="rail-group-plan"
            aria-expanded={editing}
            onClick={() => onEditingChange(!editing)}
            className={ROW_ACTION}
          >
            <Pencil aria-hidden className="size-3" />
            {group.stage === undefined ? "Set stage" : "Edit plan"}
          </button>
        )}
      </div>
      <ExpandPresence open={editing && !folded}>
        <div className="px-4 pt-1 pb-3">
          <StageEditor
            subject={group.group}
            stage={group.stage}
            onSave={(input) => setStage(target, input)}
            onCancel={() => onEditingChange(false)}
          />
        </div>
      </ExpandPresence>
      <Expand open={!folded} id={linesId}>
        {/* An inset rule, not an indent, so the lines keep the stations' columns. */}
        <ul
          aria-label={`Features in ${group.group}`}
          className="divide-y divide-border/60 shadow-[inset_2px_0_0_var(--color-border-strong)]"
        >
          {children}
        </ul>
      </Expand>
    </li>
  );
}
