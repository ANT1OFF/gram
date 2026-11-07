import { autonomyOf, type Autonomy, type WorkspaceState } from "@gram/contracts";
import { TriangleAlert } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SegmentSlab } from "@/motion";
import { SEGMENT, SEGMENT_SLAB, SEGMENT_TRACK } from "@/settings/fields";
import { useWorkspaceChanges } from "@/settings/workspace-actions";
import { autonomyNeedsConfirm } from "@/settings/workspace-settings-model";

/** Whether a merge waits for the user: Ask below Full, Automatic at Full. */
export type MergeApproval = "ask" | "automatic";

export const mergeApprovalOf = (autonomy: string): MergeApproval =>
  autonomy === "full" ? "automatic" : "ask";

/**
 * The level a pick moves a workspace to: Automatic is Full; Ask keeps a level that already asks,
 * and from Full steps down to Publish, which still pushes and opens pull requests.
 */
export const autonomyForApproval = (current: Autonomy, approval: MergeApproval): Autonomy =>
  approval === "automatic" ? "full" : current === "full" ? "publish" : current;

const CHOICES: readonly { value: MergeApproval; label: string }[] = [
  { value: "ask", label: "Ask" },
  { value: "automatic", label: "Automatic" },
];

/**
 * Merge approval as two segments, Ask and Automatic, beside the New form's Start. Automatic (Full
 * autonomy) takes the warning colour, as Full does everywhere. Without `onPick` it only shows.
 */
export function MergeApprovalSegments({
  value,
  label,
  onPick,
  disabled = false,
}: {
  value: MergeApproval;
  /** The group's accessible name, which says what the choice applies to. */
  label: string;
  onPick?: ((approval: MergeApproval) => void) | undefined;
  disabled?: boolean | undefined;
}) {
  const slab = useId();
  return (
    <span
      role="radiogroup"
      aria-label={label}
      data-testid="merge-approval"
      data-value={value}
      className={cn(SEGMENT_TRACK, "inline-flex align-middle")}
    >
      {CHOICES.map((choice) => {
        const checked = choice.value === value;
        return (
          <Button
            key={choice.value}
            type="button"
            size="xs"
            variant="ghost"
            role="radio"
            aria-checked={checked}
            data-testid={`merge-approval-${choice.value}`}
            disabled={disabled || onPick === undefined}
            onClick={() => {
              if (!checked) onPick?.(choice.value);
            }}
            className={cn(
              SEGMENT,
              "h-7 px-2.5 text-meta disabled:opacity-100",
              checked && choice.value === "automatic" && "aria-checked:text-warning",
            )}
          >
            {checked && <SegmentSlab group={slab} className={SEGMENT_SLAB} />}
            <span className="relative">{choice.label}</span>
          </Button>
        );
      })}
    </span>
  );
}

/** What the Undo toast says a pick did: to the workspace, never only to this task. */
export const mergeApprovalSaved = (workspace: string, next: Autonomy): string =>
  next === "full"
    ? `Workspace ${workspace} now merges without asking`
    : `Workspace ${workspace} now asks before merging`;

/**
 * A workspace's merge approval, changed where a task starts. It is the workspace's setting, not
 * this task's: the line names the workspace and says so on hover, the pick saves the workspace's
 * autonomy as Settings does, with an Undo that names the workspace, and Automatic (Full) is
 * confirmed first, since nothing asks after it. The confirmation and any error show on a line of their own under it (`below`).
 */
export function useWorkspaceMergeApproval(state: WorkspaceState | undefined, fallback: Autonomy) {
  const changes = useWorkspaceChanges(state);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const charter = changes.charter ?? state?.charter;
  const autonomy = charter === undefined ? fallback : autonomyOf(charter);
  const name = state?.workspace.name ?? "this workspace";

  const save = (next: Autonomy) => {
    if (charter === undefined) return;
    setConfirming(false);
    setError(undefined);
    void changes.saveCharter(
      { ...charter, autonomy: next },
      mergeApprovalSaved(name, next),
      setError,
    );
  };
  const pick = (approval: MergeApproval) => {
    if (charter === undefined) return;
    const next = autonomyForApproval(autonomy as Autonomy, approval);
    if (next === autonomy) return;
    if (autonomyNeedsConfirm(autonomy as Autonomy, next)) setConfirming(true);
    else save(next);
  };

  const below =
    confirming || error !== undefined ? (
      <span className="flex flex-col gap-1">
        {confirming && (
          <span
            role="alertdialog"
            aria-label="Merge without asking?"
            data-testid="merge-approval-confirm"
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta"
          >
            <TriangleAlert aria-hidden className="size-icon-chip shrink-0 text-warning" />
            <span className="text-foreground">
              Merge without asking? Every agent in {name} may then merge its pull requests.
            </span>
            <Button type="button" size="xs" variant="destructive" onClick={() => save("full")}>
              Merge automatically
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setConfirming(false)}>
              Keep asking
            </Button>
          </span>
        )}
        {error !== undefined && (
          <span role="alert" className="text-meta whitespace-pre-wrap text-destructive">
            {error}
          </span>
        )}
      </span>
    ) : undefined;

  return {
    autonomy,
    approval: mergeApprovalOf(autonomy),
    pick,
    busy: changes.busy,
    ready: charter !== undefined,
    below,
    label: `Merge approval for ${name}, a workspace setting`,
  };
}
