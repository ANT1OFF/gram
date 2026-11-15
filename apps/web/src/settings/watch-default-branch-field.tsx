import type { OrchestratorCharter } from "@gram/contracts";

import { Toggle } from "./fields";
import { withWatchDefaultBranch } from "./workspace-settings-model";

/**
 * Whether the orchestrator is told when a workspace repo's default branch turns red after merges,
 * and which pull requests merged since it was green. Off by default; Gram only tells.
 */
export function WatchDefaultBranchField({
  charter,
  disabled,
  onChange,
}: {
  charter: OrchestratorCharter;
  disabled: boolean;
  onChange: (charter: OrchestratorCharter, title: string) => void;
}) {
  const on = charter.watchDefaultBranch === true;
  return (
    <div data-testid="watch-default-branch" data-value={on ? "on" : "off"}>
      <Toggle
        label="Watch the default branch"
        description="Tell the orchestrator when main turns red after merges, and which pull requests could be why."
        keywords={["main", "default branch", "red", "ci", "revert", "bisect", "broken build"]}
        learnMore={
          <p>
            Gram reads the branch's Actions runs every five minutes. It never reverts or merges by
            itself: the orchestrator has a worker rerun the failed jobs, then revert and re-land the
            change that broke it, under the workspace's own autonomy and merge rules.
          </p>
        }
        checked={on}
        disabled={disabled}
        onChange={(next) =>
          onChange(
            withWatchDefaultBranch(charter, next),
            next
              ? "The default branch is watched after merges"
              : "The default branch isn't watched",
          )
        }
      />
    </div>
  );
}
