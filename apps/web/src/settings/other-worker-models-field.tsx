import type { OrchestratorCharter } from "@gram/contracts";

import { Toggle } from "./fields";
import { withOtherWorkerModels } from "./workspace-settings-model";

/**
 * Whether the orchestrator may start a worker on a model off the roster when none of the roster's
 * fits the work, or a council needs one it lacks. On for new workspaces; off where it was never set.
 */
export function OtherWorkerModelsField({
  charter,
  disabled,
  onChange,
}: {
  charter: OrchestratorCharter;
  disabled: boolean;
  onChange: (charter: OrchestratorCharter, title: string) => void;
}) {
  const on = charter.otherWorkerModels === true;
  return (
    <div data-testid="other-worker-models" data-value={on ? "on" : "off"}>
      <Toggle
        label="Use other models"
        description="Let the orchestrator use other models when none of these fit."
        keywords={["other models", "worker models", "roster", "council", "allow-list"]}
        learnMore={
          <p>
            The models above stay the preferred ones. The orchestrator goes beyond them only when
            none fits the work, or a council of reviewers needs a model they lack, and says which it
            picked and why: any model your signed-in Claude Code or Codex lists, or one on a gateway
            these already use. Such a worker runs at Standard speed and at high effort or below.
          </p>
        }
        checked={on}
        disabled={disabled}
        onChange={(next) =>
          onChange(
            withOtherWorkerModels(charter, next),
            next ? "Other worker models allowed" : "Workers only on these models",
          )
        }
      />
    </div>
  );
}
