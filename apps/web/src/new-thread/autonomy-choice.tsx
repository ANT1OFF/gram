import type { Autonomy } from "@gram/contracts";

import { Hint } from "@/components/hint";
import { FOCUS_RING } from "@/lib/selection";
import { cn } from "@/lib/utils";
import { OptionGroup } from "@/settings/fields";
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
  const full = autonomyLevel("full");
  return (
    <div data-testid={testId} data-value={value} className="flex flex-col gap-2">
      <span aria-hidden className="text-meta font-medium text-muted-foreground">
        {label}
      </span>
      {explain && <AuthorityExplainer className="mb-0.5" />}
      <OptionGroup<Autonomy>
        label={label}
        options={AUTONOMY_LEVELS.map((level) => ({
          value: level.value,
          label: level.label,
          description: AUTONOMY_LINE[level.value],
          testId: `autonomy-${level.value}`,
        }))}
        value={value}
        onChange={onChange}
        disabled={disabled}
      />
      {value === "full" && (
        <p data-testid="autonomy-full-note" className="text-meta text-muted-foreground">
          Your branch protection and required reviews are the only gate.{" "}
          <Hint
            label={full.detail}
            render={
              <button
                type="button"
                className={cn(
                  "rounded-sm text-foreground underline decoration-muted-foreground/60 underline-offset-2 hover:decoration-foreground",
                  FOCUS_RING,
                )}
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
