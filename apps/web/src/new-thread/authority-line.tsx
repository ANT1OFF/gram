import type { Autonomy, PermissionMode } from "@gram/contracts";
import { Shield } from "lucide-react";
import { createElement } from "react";

import { MODE_ICONS, MODE_OPTIONS } from "@/composer/options";
import { FOCUS_RING } from "@/lib/selection";
import { cn } from "@/lib/utils";
import { AUTONOMY_ICON } from "@/orchestration/autonomy-chip";
import { presentAutonomy } from "@/settings/workspace-settings-model";
import { modeWarning } from "@/thread/mode-warning";
import { known } from "@/thread/orchestration-model";

/** Whether a workspace's orchestrator merges unasked at each level, said of several workers. */
const PLAN_MERGE: Readonly<Record<Autonomy, string>> = {
  supervised: "Asks you before a push, a pull request or a merge",
  publish: "Opens pull requests; merging waits for you",
  full: "Merges pull requests without asking you",
};

/** The same, said of the one worker a direct start makes. */
const WORKER_MERGE: Readonly<Record<Autonomy, string>> = {
  supervised: "Asks you before a push, a pull request or a merge",
  publish: "Opens its pull request; merging waits for you",
  full: "Merges its pull request without asking you",
};

/** The New form's summary beside Start, in its three parts. */
export interface TaskSummary {
  /** Where it runs: the workspace, or the one this start makes. */
  readonly where: string;
  /** Which orchestrator supervises it, or the user while a direct worker is held. */
  readonly who: string;
  /** Whether that orchestrator may merge without asking: the workspace's autonomy in words. */
  readonly merge: string;
}

/**
 * Where a task runs, who supervises it and whether that orchestrator may merge, as three short
 * parts: the workspace by name (or the one a start makes), its orchestrator (the user while a
 * direct worker is held), then what the workspace's autonomy lets it merge unasked. A level this
 * build doesn't know says so rather than guessing.
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
  return {
    where: makesOne ? `Runs in a new ${workspace} workspace` : `Runs in ${workspace}`,
    who:
      way === "plan"
        ? `Planned by ${orchestrator}`
        : hold
          ? `You direct it until you hand it to ${orchestrator}`
          : `Supervised by ${orchestrator}`,
    merge:
      known(way === "plan" ? PLAN_MERGE : WORKER_MERGE, autonomy as Autonomy) ??
      presentAutonomy(autonomy).description.replace(/\.$/, ""),
  };
}

/**
 * The New form's one summary beside Start: where the task runs, which orchestrator supervises it
 * and whether that orchestrator may merge (amber at Full, as everywhere the level shows). The merge
 * part opens the controls that change it (`onChange`); this line is never folded away.
 */
export function TaskAuthorityLine({
  way,
  workspace,
  makesOne,
  autonomy,
  hold,
  onChange,
}: {
  way: "plan" | "direct";
  workspace: string;
  makesOne?: boolean | undefined;
  autonomy: string;
  hold: boolean;
  /** Opens the autonomy and hold controls; the merge part is then a button. */
  onChange?: (() => void) | undefined;
}) {
  const level = presentAutonomy(autonomy);
  const icon = known(AUTONOMY_ICON, autonomy as Autonomy) ?? Shield;
  const summary = taskSummary({ way, workspace, makesOne, autonomy, hold });
  const merge = (
    <span className={cn("font-medium", level.warn ? "text-warning" : "text-foreground")}>
      {summary.merge}
    </span>
  );
  return (
    <p
      data-testid="task-authority"
      data-autonomy={autonomy}
      data-hold={hold ? "true" : undefined}
      className="flex min-w-0 items-start gap-1.5 text-reading text-muted-foreground"
    >
      {createElement(icon, {
        "aria-hidden": true,
        className: cn("mt-1 size-icon-row shrink-0", level.warn && "text-warning"),
      })}
      <span className="min-w-0">
        <span className="text-foreground">{summary.where}</span>
        {" · "}
        {summary.who}
        {" · "}
        {onChange === undefined ? (
          merge
        ) : (
          <button
            type="button"
            data-testid="task-authority-change"
            title={`${level.label} autonomy. Change it under Control and approvals`}
            onClick={onChange}
            className={cn(
              "rounded-sm underline decoration-dotted underline-offset-2 hover:decoration-solid",
              FOCUS_RING,
            )}
          >
            {merge}
          </button>
        )}
        .
      </span>
    </p>
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
