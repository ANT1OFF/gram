import type { Autonomy, PermissionMode } from "@gram/contracts";
import { Network, Shield } from "lucide-react";
import { createElement } from "react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { MODE_ICONS, MODE_OPTIONS } from "@/composer/options";
import { FOCUS_RING } from "@/lib/selection";
import { cn } from "@/lib/utils";
import { AUTONOMY_ICON } from "@/orchestration/autonomy-chip";
import { presentAutonomy } from "@/settings/workspace-settings-model";
import { modeWarning } from "@/thread/mode-warning";
import { known } from "@/thread/orchestration-model";

import { MergeApprovalSegments, mergeApprovalOf, type MergeApproval } from "./merge-approval";

/** Whether a merge waits for the user at each level: the merge approval line's value. */
const MERGE_APPROVAL: Readonly<Record<Autonomy, string>> = {
  supervised: "Ask",
  publish: "Ask",
  full: "Automatic",
};

/** What that means for several workers' pull requests, after the value. */
const PLAN_MERGE: Readonly<Record<Autonomy, string>> = {
  supervised: "Asks before a push, a pull request or a merge",
  publish: "Opens pull requests; merging waits for you",
  full: "Merges pull requests without asking you",
};

/** The same, said of the one worker a direct start makes. */
const WORKER_MERGE: Readonly<Record<Autonomy, string>> = {
  supervised: "Asks before a push, a pull request or a merge",
  publish: "Opens its pull request; merging waits for you",
  full: "Merges its pull request without asking you",
};

/** The New form's summary beside Start: who owns the task, then, apart, who approves a merge. */
export interface TaskSummary {
  /** Where it runs: the workspace, or the one this start makes. */
  readonly where: string;
  /**
   * Whom it reports to: the orchestrator that plans it or that the worker reports to, or the user
   * while a direct worker is held. Ownership only; it says nothing of merging.
   */
  readonly who: string;
  /** Whether a merge waits for the user: "Automatic" or "Ask", the workspace's autonomy. */
  readonly approval: string;
  /** What that approval means for this start, in a few words. */
  readonly merge: string;
}

/**
 * Where a task runs and whom it reports to, and, as a separate labelled part, whether its merge
 * waits for the user. Reporting is ownership: a worker reports to its orchestrator whatever that
 * orchestrator may merge, so the two are never said in one breath. A level this build doesn't know
 * says so rather than guessing.
 */
export function taskSummary({
  way,
  workspace,
  makesOne = false,
  autonomy,
  hold,
}: {
  way: "plan" | "direct";
  /** The workspace's name, or the repository's for a workspace this start makes. */
  workspace: string;
  makesOne?: boolean | undefined;
  autonomy: string;
  hold: boolean;
}): TaskSummary {
  const orchestrator = `the ${workspace} orchestrator`;
  const level = presentAutonomy(autonomy);
  return {
    where: makesOne ? `Runs in a new ${workspace} workspace` : `Runs in ${workspace}`,
    who:
      way === "plan"
        ? `Planned by ${orchestrator}`
        : hold
          ? `You direct it until you hand it to ${orchestrator}`
          : `Reports to ${orchestrator}`,
    approval: known(MERGE_APPROVAL, autonomy as Autonomy) ?? level.label,
    merge:
      known(way === "plan" ? PLAN_MERGE : WORKER_MERGE, autonomy as Autonomy) ??
      level.description.replace(/\.$/, ""),
  };
}

/**
 * The New form's summary beside Start, one fact a line on one text edge, each line's mark in a
 * column of its own: where the task runs (`Runs in billing-api · api · New worktree, new branch`,
 * the places as the form names them), marked Remembered when it is the last task's target rather
 * than where the user is, with Change (`onChangeWhere`) to pick another; then whom it reports to;
 * then Merge approval, Ask or Automatic, with what that means for this start (amber at Automatic,
 * as everywhere Full shows). `approval` makes the merge approval a choice; none of it is folded.
 */
export function TaskAuthorityLine({
  way,
  workspace,
  places = [],
  makesOne,
  autonomy,
  hold,
  remembered = false,
  onChangeWhere,
  changeWhereHint,
  approval,
}: {
  way: "plan" | "direct";
  workspace: string;
  /** The repository and checkout after the workspace, as the form names them. */
  places?: readonly string[] | undefined;
  makesOne?: boolean | undefined;
  autonomy: string;
  hold: boolean;
  /** Whether the target is the last task's, kept from before rather than read off this place. */
  remembered?: boolean | undefined;
  /** Opens where it runs to change it. */
  onChangeWhere?: (() => void) | undefined;
  /** Change's tooltip, with its shortcut. */
  changeWhereHint?: string | undefined;
  /** The merge approval as a choice: what it applies to, and the pick. */
  approval?:
    | {
        readonly label: string;
        readonly onPick: (approval: MergeApproval) => void;
        readonly disabled?: boolean | undefined;
      }
    | undefined;
}) {
  const level = presentAutonomy(autonomy);
  const icon = known(AUTONOMY_ICON, autonomy as Autonomy) ?? Shield;
  const summary = taskSummary({ way, workspace, makesOne, autonomy, hold });
  return (
    <span
      data-testid="task-authority"
      data-autonomy={autonomy}
      data-hold={hold ? "true" : undefined}
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-1.5 gap-y-1 text-reading text-muted-foreground"
    >
      <Network aria-hidden className="col-start-1 mt-1 size-icon-row shrink-0" />
      <span
        data-testid="task-destination"
        data-remembered={remembered ? "true" : undefined}
        className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
      >
        <span className="min-w-0 text-foreground">{[summary.where, ...places].join(" · ")}</span>
        {remembered && (
          <Hint
            label="Where your last task went. Change picks another."
            render={
              <span
                tabIndex={0}
                data-testid="task-destination-remembered"
                className={cn(
                  "rounded-xs border border-border px-1.5 text-meta text-muted-foreground",
                  FOCUS_RING,
                )}
              />
            }
          >
            Remembered
          </Hint>
        )}
        {onChangeWhere !== undefined && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            data-testid="task-destination-change"
            aria-label={`Change where it runs${changeWhereHint === undefined ? "" : ` (${changeWhereHint})`}`}
            title={
              changeWhereHint === undefined
                ? undefined
                : `Change where it runs (${changeWhereHint})`
            }
            onClick={onChangeWhere}
          >
            Change
          </Button>
        )}
      </span>
      <span data-testid="task-owner" className="col-start-2">
        {summary.who}
      </span>
      {createElement(icon, {
        "aria-hidden": true,
        className: cn("col-start-1 mt-1.5 size-icon-row shrink-0", level.warn && "text-warning"),
      })}
      <span
        data-testid="task-merge-approval"
        className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
      >
        <span>Merge approval</span>
        {approval === undefined ? (
          <span className={cn("font-medium", level.warn ? "text-warning" : "text-foreground")}>
            {summary.approval}
          </span>
        ) : (
          <MergeApprovalSegments
            value={mergeApprovalOf(autonomy)}
            label={approval.label}
            onPick={approval.onPick}
            disabled={approval.disabled}
          />
        )}
        <span className="min-w-0">{summary.merge}.</span>
      </span>
    </span>
  );
}

/** A single agent chat's line: the user directs one agent, and its mode says what it asks first. */
export function chatAuthority(mode: PermissionMode): { label: string; line: string } {
  const option = MODE_OPTIONS.find((each) => each.value === mode);
  return {
    label: option?.label ?? mode,
    line: `You direct one agent in this folder, with no orchestrator. ${option?.description ?? ""}`.trim(),
  };
}

/** The chat form's counterpart of `TaskAuthorityLine`: the mode by name, amber when it never asks. */
export function ChatAuthorityLine({ mode }: { mode: PermissionMode }) {
  const { label, line } = chatAuthority(mode);
  const warned = modeWarning(mode) !== undefined;
  return (
    <p
      data-testid="chat-authority"
      data-mode={mode}
      className="flex min-w-0 items-start gap-1.5 text-reading text-muted-foreground"
    >
      {createElement(MODE_ICONS[mode], {
        "aria-hidden": true,
        className: cn("mt-1 size-icon-row shrink-0", warned && "text-warning"),
      })}
      <span className="min-w-0">
        <span className={cn("font-medium", warned ? "text-warning" : "text-foreground")}>
          {label}
        </span>
        {" · "}
        {line}
      </span>
    </p>
  );
}
