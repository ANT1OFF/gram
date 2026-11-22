import type { Autonomy } from "@gram/contracts";

import { OptionGroup } from "@/settings/fields";
import { usePersonMerges } from "@/embed/store";
import { autonomyLevels } from "@/settings/workspace-settings-model";

/** Each level in one plain line: what it does without asking you. */
export const AUTONOMY_LINE: Readonly<Record<Autonomy, string>> = {
  supervised: "Asks before a push, a pull request or a merge.",
  publish: "Pushes and opens pull requests. Asks before a merge.",
  full: "Pushes, opens and merges pull requests without asking.",
};

/** The same lines where no agent may merge (`machines.merges: "person"`). */
export const PERSON_MERGES_LINE: Readonly<Record<Autonomy, string>> = {
  supervised: "Asks before a push or a pull request. You merge.",
  publish: "Pushes and opens pull requests. Asks before a force or deleting push. You merge.",
  full: "Pushes and opens pull requests without asking. You merge.",
};

/** Each level's line as this deployment words it. */
export const useAutonomyLine = (): Readonly<Record<Autonomy, string>> =>
  usePersonMerges() ? PERSON_MERGES_LINE : AUTONOMY_LINE;

/**
 * How far a new workspace's agents go unasked, picked where the work is described: the three
 * levels side by side, one plain line each, which say it all. Settings has each level's detail.
 */
export function AutonomyChoice({
  value,
  onChange,
  disabled = false,
  label = "Autonomy",
  testId = "task-autonomy",
  source,
}: {
  value: Autonomy;
  onChange: (autonomy: Autonomy) => void;
  disabled?: boolean;
  label?: string;
  testId?: string;
  /** Where the level it opens on comes from, while nobody has picked one here. */
  source?: string | undefined;
}) {
  const personMerges = usePersonMerges();
  const lines = useAutonomyLine();
  return (
    <div data-testid={testId} data-value={value} className="flex flex-col gap-2">
      <span aria-hidden className="text-meta font-medium text-muted-foreground">
        {label}
      </span>
      {source !== undefined && (
        <span data-testid={`${testId}-source`} className="text-meta text-description">
          {source}
        </span>
      )}
      <OptionGroup<Autonomy>
        label={label}
        options={autonomyLevels(personMerges).map((level) => ({
          value: level.value,
          label: level.label,
          description: lines[level.value],
          testId: `autonomy-${level.value}`,
        }))}
        value={value}
        onChange={onChange}
        disabled={disabled}
      />
    </div>
  );
}
