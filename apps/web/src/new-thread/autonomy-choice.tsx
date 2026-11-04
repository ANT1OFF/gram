import type { Autonomy } from "@gram/contracts";
import { useId } from "react";

import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";
import { SegmentSlab } from "@/motion";
import { SEGMENT_SLAB, SEGMENT_TRACK } from "@/settings/fields";
import { AUTONOMY_LEVELS, autonomyLevel } from "@/settings/workspace-settings-model";

import { AuthorityExplainer } from "./authority-explainer";

/** Each level in one plain line: what it does without asking you. */
export const AUTONOMY_LINE: Readonly<Record<Autonomy, string>> = {
  supervised: "Asks before a push, a pull request or a merge.",
  publish: "Pushes and opens pull requests. Asks before a merge.",
  full: "Pushes, opens and merges pull requests without asking.",
};

/**
 * How far a new workspace's agents go unasked, picked where the work is described: the three
 * levels side by side, one plain line each. Full, the default, gets one calm line on what then
 * stands between an agent and the repository, with the whole story behind "What does this allow?".
 */
export function AutonomyChoice({
  value,
  onChange,
  disabled = false,
  label = "Autonomy",
  testId = "task-autonomy",
  explain = false,
}: {
  value: Autonomy;
  onChange: (autonomy: Autonomy) => void;
  disabled?: boolean;
  label?: string;
  testId?: string;
  /** Tells autonomy apart from a thread's permission mode first, where a workspace is set up. */
  explain?: boolean;
}) {
  const slab = useId();
  const labelId = useId();
  const full = autonomyLevel("full");
  return (
    <div data-testid={testId} data-value={value} className="flex flex-col gap-2">
      <span id={labelId} className="text-xs font-medium text-muted-foreground">
        {label}
      </span>
      {explain && <AuthorityExplainer className="mb-0.5" />}
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className={cn(SEGMENT_TRACK, "grid grid-cols-1 sm:grid-cols-3")}
      >
        {AUTONOMY_LEVELS.map((level) => {
          const checked = level.value === value;
          return (
            <button
              key={level.value}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={level.label}
              aria-description={AUTONOMY_LINE[level.value]}
              disabled={disabled}
              data-testid={`autonomy-${level.value}`}
              onClick={() => {
                if (!checked) onChange(level.value);
              }}
              className="relative flex flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-checked:text-foreground"
            >
              {checked && <SegmentSlab group={slab} className={SEGMENT_SLAB} />}
              <span className="text-sm font-medium">{level.label}</span>
              <span className="text-xs text-muted-foreground">{AUTONOMY_LINE[level.value]}</span>
            </button>
          );
        })}
      </div>
      {value === "full" && (
        <p data-testid="autonomy-full-note" className="text-xs text-muted-foreground">
          Your branch protection and required reviews are the only gate.{" "}
          <Hint
            label={full.detail}
            render={
              <button
                type="button"
                className="rounded-sm text-foreground underline decoration-muted-foreground/60 underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              />
            }
          >
            What does this allow?
          </Hint>
        </p>
      )}
    </div>
  );
}
